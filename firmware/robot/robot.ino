#include "pico/stdlib.h"
#include "pico/time.h"
#include <math.h>
#include <BasicLinearAlgebra.h>

// Task #3 (2026-11-20): the robot also talks to the web pages over WiFi. It
// creates its own network (access point) and serves the same lines it prints
// on USB serial as Server-Sent Events; commands arrive as HTTP GET:
//   GET /events          the output lines, one "data: <line>" event each
//   GET /cmd?c=LED%204%201   a command, as typed on serial ("LED 4 1")
//   GET /                "RA robot ok" (to test from a browser)
// USB serial keeps working as before. 0 = no WiFi (also for a Pico without W).
// Needs the board "Raspberry Pi Pico W" in Arduino IDE (Tools > Board) and
// wifi_secrets.h (copy wifi_secrets.example.h; it is not in git).
#define USE_WIFI 1
#if USE_WIFI
#if !defined(ARDUINO_RASPBERRY_PI_PICO_W) && !defined(PICO_CYW43_SUPPORTED)
#error "USE_WIFI needs Tools > Board > Raspberry Pi Pico W (or set USE_WIFI 0)"
#endif
#if __has_include("wifi_secrets.h")
#include "wifi_secrets.h"
#else
#error "Copy wifi_secrets.example.h to wifi_secrets.h (same folder) and set the password"
#endif
#include <WiFi.h>
#endif

repeating_timer_t timer;
const int N = 2500;  //number of samples in each buffer
const int samplingFreq = 25000;
const int N_PD = 3;
const int N_LED = 9;
const int N_Z = N_LED * N_PD;  // number of RSS measurements (was 12 with 4 LEDs, 18 with 6)
const int N_STATE = 8;  // x, vx, y, vy, theta, omega, z, vz (was 6 without z)
const int pins[N_PD] = { 28, 27, 26 };

// Same order as p:           LED4     LED5     LED7     LED8     LED1     LED2     LED0     LED3     LED6
const float Fref[N_LED] = { 2300.0f, 2900.0f, 3700.0f, 4100.0f, 1300.0f, 1700.0f, 1100.0f, 1900.0f, 3100.0f };
// Sampling runs all the time (2026-11-19, branch feature/task-2-continuous-
// sampling): the timer writes every photodiode reading into a ring buffer and
// loop() takes the newest N samples every UPDATE_EVERY samples. Windows
// overlap (N = 2500 but a new one starts every 1250), so each RSS still
// averages 0.1 s of signal and has the same noise as before, while the
// position comes out 20 times a second instead of 8.4. Before, loop() filled a
// buffer of N, waited for it (100 ms doing nothing) and computed afterwards.
//
// RING_N - N samples (100 ms) may pass between taking the snapshot of the
// write position and finishing the demodulation before the oldest sample of
// the window is overwritten; the demodulation takes about 12 ms.
const int RING_N = 2 * N;                  // samples kept per photodiode (10 bit, so int16)
const int UPDATE_EVERY = 1250;             // samples between updates: 50 ms = 20 Hz
volatile int16_t ring[N_PD][RING_N];
volatile int ringWrite = 0;                // next slot the timer writes
volatile uint32_t sampleCount = 0;         // samples taken since power-up

// Demodulation without sin() / cos() in the loop (2026-11-19, they took most
// of the time on the Pico, which has no FPU). Every LED frequency is a
// multiple of F_STEP, so the phase of every reference repeats after
// LUT_N = samplingFreq / F_STEP samples: one sin and one cos table of LUT_N
// values (scaled by LUT_SCALE) serves all LEDs, stepping Fref / F_STEP entries
// per sample. A new LED frequency must be a multiple of F_STEP, and N a
// multiple of LUT_N (tests/firmware-math.test.js checks both).
const int F_STEP = 100;                   // Hz
const int LUT_N = samplingFreq / F_STEP;  // 250
const int LUT_SCALE = 16384;              // table values are sin * 2^14
int16_t sinQ[LUT_N], cosQ[LUT_N];
int lutStep[N_LED];                       // table entries per sample, for each LED

//VARIBLES OF EKF/UKF
const float m = 1.0;  //Lambertian order
const float FoV = M_PI / 2;
float T = 0.2;  // seconds between EKF updates; set from the measured loop time in loop() (about 0.33 s)
const float al[N_PD] = { 0, 2.0*M_PI/3.0, -2.0*M_PI/3.0 };
// Elevation of each photodiode's normal above the floor. The pyramid faces
// measure 35 deg from the floor (2026-11-19), so the normal is 90 - 35 = 55 deg
// (was M_PI / 3 = 60 deg, a face of 30 deg).
const float be = 55.0f * M_PI / 180.0f;
// const float PtxGamma[N_LED] = { 0.46f, 0.41f, 0.55f, 0.51f };  
// Which LEDs the EKF uses (same order as p). An LED set to false is not
// demodulated and adds nothing to the update. These are the values at power-up;
// the web page can change them at run time (see readCommands()).
const int LED_NUM[N_LED] = {     4,     5,    7,    8,    1,    2,    0,    3,    6 };  // LED number per row of p
bool LED_ON[N_LED]       = { false, false, true, true, true, true, false, false, false };  // only LED 7, 8, 1, 2 on at start (2026-11-19)
// LED 7, 8, 1, 2: fitted together with PD_GAIN and RSS_OFFSET below
// (calib-model.js fitModel(), data/2026-11-19/calib_130953.csv, 8 poses,
// theta = 0, m = 1, be = 55 deg, all poses taken as z = 0). Refitted on
// 2026-11-24 with the LED rows at y = +-0.515 m: model misfit 9.1 -> 8.6 %,
// x / y on the PC (leave one pose out) 3.57 -> 3.61 cm. With y = +-0.5 they
// were 0.447, 0.435, 0.538, 0.506, PD_GAIN 1, 0.917, 0.906, RSS_OFFSET 0.0689.
// LED 4, 5 (not lit) and LED 0, 3, 6 (off) are not calibrated.
// To go back to the model without PD_GAIN / RSS_OFFSET (x / y about 1-2 cm on
// the board with ESTIMATE_Z = false), use PD_GAIN = 1, 1, 1, RSS_OFFSET = 0 and
//   { 0.490f, 0.490f, 0.476f, 0.457f, 0.562f, 0.525f, 0.460f, 0.460f, 0.460f }
// (with be = 60 deg the gammas were 0.453, 0.436, 0.536, 0.504).
const float PtxGamma[N_LED] = { 0.490f, 0.490f, 0.443f, 0.430f, 0.534f, 0.503f, 0.460f, 0.460f, 0.460f };
// Photodiode gain relative to PD 0 (pin GP28). The calibration data read PD 0
// 12-21 % above the model for every LED; PD 1 and 2 are about 8-9 % lower.
const float PD_GAIN[N_PD] = { 1.000f, 0.915f, 0.905f };
// Added to every RSS of a lit LED: reflections and the noise floor of the
// demodulation. Far LEDs (> 1.25 m) read about 21 % above the model without it.
// With these two, the model misfit fell from 12-18 % to 8-10 % and x / y on
// the PC (leave one pose out) from 5.9 to 3.6 cm.
const float RSS_OFFSET = 0.0811f;
const float eps = 0.01; //0.01;
const float sigma2 = 0.01; //0.1, 0.4, 0.1, 0.005; 
// const float q = 0.01;
int mode = 2; //1 is RSS only. 2 is the coordinate.
// true = print how long each part of a loop took, as a "# T ..." line (the web
// pages skip lines that start with #). Switched with the command "TIMING <0|1>".
bool PRINT_TIMING = false;

// LED positions (m): x, y, height above the photodiodes. The rows of LED 8 7 6
// and 2 1 0 are 0.515 m from the middle row (measured on the frame,
// 2026-11-24; was 0.5); x is 0.5 m. The LEDs are 0.92 m above the floor (0.89 m
// above the 3 cm steel beams that run under the top and bottom rows).
BLA::Matrix<N_LED, 3> p = { 0, 0, 0.920, //0.93 - 0.03 - 0.01   LED4
                            -0.5, 0, 0.920,                  // LED5
                            0, 0.515, 0.920,                 // LED7
                            -0.5, 0.515, 0.920,              // LED8
                            0, -0.515, 0.920,                // LED1
                            -0.5, -0.515, 0.920,             // LED2
                            0.5, -0.515, 0.920,              // LED0
                            0.5, 0, 0.920,                   // LED3
                            0.5, 0.515, 0.920 };             // LED6

BLA::Matrix<3, 1> uk = { 0.0, 0.0, -1.0 };
BLA::Matrix<3, 3> v = { cos(be) * cos(al[0]), -cos(be) * sin(al[0]), sin(be),
                        cos(be) * cos(al[1]), -cos(be) * sin(al[1]), sin(be),
                        cos(be) * cos(al[2]), -cos(be) * sin(al[2]), sin(be) };
// EKF state (N_STATE = 8): x, vx, y, vy, theta, omega, z, vz  (m, rad, per s).
// z is the robot's height above its place on the floor: the photodiodes are at
// z = 0 when it sits on the floor, the LEDs at p(k, 2). z and vz were added at
// the end so x (0), y (2) and theta (4) keep their index.
const int IX = 0, IY = 2, ITH = 4, IZ = 6;
// false = keep z at 0 (robot always on the floor), as before z was added.
// On since 2026-11-19 (task #2 z axis). z follows any brightness error of the
// model: +1 cm of z changes RSS by only about 0.8 %, so a 5 % error reads as
// about 6 cm. On the PC, a robot on the floor read z within +-3 cm at 7 of the
// 8 calibration poses (rms 2.3 cm) and x / y did not get worse. The web page
// can zero z where the robot stands. Set false if the robot stays on the floor.
const bool ESTIMATE_Z = true;
// z is kept in this range (m): the floor (the robot cannot be below it; the
// user asked for no negative z, 2026-11-19; it was -0.05 to leave room for
// noise) and well below the LEDs, where the path-loss model blows up
// (distance -> 0). A model error that pulls z below the floor now shows up as
// z stuck at 0 while x / y take up the difference, as with ESTIMATE_Z = false.
const float Z_MIN = 0.0f, Z_MAX = 0.80f;

BLA::Matrix<N_STATE, 1> xHnm1nm1 = { 0.0 };
BLA::Matrix<N_STATE, 1> xHnnm1 = { 0.0 };
BLA::Matrix<N_Z, 1> zn = { 0.0 };
BLA::Matrix<N_Z, 1> zHn = { 0.0 };
// A, P, Q, R and I are filled in initEkf() so they follow N_STATE.
BLA::Matrix<N_STATE, N_STATE> A = { 0.0 };
BLA::Matrix<N_Z, N_STATE> Jn = { 0.0 };
BLA::Matrix<N_STATE, N_Z> Kn = { 0.0 };
BLA::Matrix<N_STATE, N_STATE> Pnm1nm1 = { 0.0 };
BLA::Matrix<N_STATE, N_STATE> Pnnm1 = { 0.0 };
BLA::Matrix<N_STATE, N_STATE> Q = { 0.0 };
BLA::Matrix<N_Z, N_Z> R = { 0.0 };
BLA::Matrix<N_STATE, N_STATE> I6 = { 0.0 };  // identity (name kept from the 6-state version)

// Q for x, y, z and their velocities was 1e-6: the position lagged, ran
// about 8 cm past a robot that stopped and took about 10 s to come back
// (move_straight test, 2026-11-19). 1e-4 settles in about 2-3 s with
// under 1 cm of jitter when still (EKF replica on the PC).
//                          x     vx    y     vy    th    om    z     vz
const float Q0[N_STATE] = { 1e-4, 1e-4, 1e-4, 1e-4, 1e-2, 1e-2, 1e-4, 1e-4 };
// Q0 was tuned as the noise added per update when one update took T_REF
// seconds. loop() scales it by T / T_REF, so the filter keeps the same
// behaviour per second when the updates come faster. (Q added unscaled at,
// say, 8 Hz would be 2.7 times the process noise per second: more jitter.)
const float T_REF = 0.33f;
// true  = correct the state one RSS value at a time, lit LEDs only (fast).
// false = the earlier update over all N_Z values with a 27 x 27 inverse.
// Both give the same state and covariance (R is diagonal; the Jacobian and the
// prediction are taken once at xHnnm1 either way). tests/firmware-math.test.js
// checks this arithmetic. Set false to compare on the board.
const bool EKF_SEQUENTIAL = true;

// Same values as the 6-state version for x, y and theta; z / vz use the same
// as x / y. (Earlier tuning tries are in git history.)
void initEkf() {
  //                          x     vx    y     vy    th    om    z     vz
  const float P0[N_STATE] = { 0.01, 1,    0.01, 1,    0.01, 1,    0.01, 1    };
  for (int i = 0; i < N_STATE; i++) {
    A(i, i) = 1.0;
    I6(i, i) = 1.0;
    Pnm1nm1(i, i) = P0[i];
    Q(i, i) = Q0[i];
  }
  for (int i = 0; i < N_STATE; i += 2) A(i, i + 1) = T;  // position += T * velocity
  for (int i = 0; i < N_Z; i++) R(i, i) = sigma2;
}

// Fills the demodulation tables. The second half is the first half negated
// (sin and cos of an angle half a turn on), so each table adds up to exactly 0
// and the constant part of the photodiode signal cancels exactly.
void initDemod() {
  const int half = LUT_N / 2;
  for (int i = 0; i < half; i++) {
    const double a = 2.0 * M_PI * i / LUT_N;
    sinQ[i] = (int16_t)lround(LUT_SCALE * sin(a));
    cosQ[i] = (int16_t)lround(LUT_SCALE * cos(a));
    sinQ[i + half] = -sinQ[i];
    cosQ[i + half] = -cosQ[i];
  }
  for (int f = 0; f < N_LED; f++) lutStep[f] = ((int)lround(Fref[f] / F_STEP)) % LUT_N;
}

//----------------------------------------------------------------------
// callback called every 40 microseconds
bool timer_callback(repeating_timer_t* t) {
  const int w = ringWrite;
  for (int g = 0; g < N_PD; g++)
    ring[g][w] = (int16_t)analogRead(pins[g]);
  ringWrite = (w + 1 == RING_N) ? 0 : w + 1;
  sampleCount++;
  return true;
}

float vectorNorm(const BLA::Matrix<3, 1>& z) {
  return sqrt(z(0, 0) * z(0, 0) + z(1, 0) * z(1, 0) + z(2, 0) * z(2, 0));
}

const float COS_FOV = cos(FoV);

// Path loss from LED k to photodiode l for a robot at (x0, y0, z0) whose
// heading has cosine c0 and sine s0. The same formula as before, written out
// in single precision (2026-11-19: the EKF calls this about 100 times per
// update, and the matrix temporaries, double cos() / sin() and pow() made it
// slow on the Pico). It was:
//   p0 = (x0, y0, z0), pk = row k of p, vl = row l of v
//   Omega0 = { cos(t0), sin(t0), 0,  -sin(t0), cos(t0), 0,  0, 0, 1 }
//   dk = |p0 - pk|
//   cosPhikl = (p0 - pk) . uk / dk
//   cosPsikl = (pk - p0) . (Omega0 * vl) / dk
//   if (cosPsikl > cos(FoV)) return (m + 1) * pow(cosPhikl, m) * cosPsikl / pow(dk, 2);
//   else return 0;
// Callers multiply by PtxGamma[k], so it must not be applied here as well.
float pathLossCS(int k, int l, float x0, float y0, float z0, float c0, float s0) {
  const float dx = x0 - p(k, 0), dy = y0 - p(k, 1), dz = z0 - p(k, 2);  // p0 - pk
  const float dk = sqrtf(dx * dx + dy * dy + dz * dz);
  const float cosPhikl = (dx * uk(0) + dy * uk(1) + dz * uk(2)) / dk;
  // w = Omega0 * vl
  const float w0 = c0 * v(l, 0) + s0 * v(l, 1);
  const float w1 = -s0 * v(l, 0) + c0 * v(l, 1);
  const float w2 = v(l, 2);
  const float cosPsikl = -(dx * w0 + dy * w1 + dz * w2) / dk;
  if (cosPsikl > COS_FOV)
    return (m + 1) * (m == 1.0f ? cosPhikl : powf(cosPhikl, m)) * cosPsikl / (dk * dk);
  else
    return 0;
}

float pathLossWithoutGamma(int k, int l, float x0, float y0, float z0, float t0) {
  // k = LED index, l = PD index; (x0, y0, z0) = robot position, t0 = heading
  return pathLossCS(k, l, x0, y0, z0, cosf(t0), sinf(t0));
}

void computeJacobian(const BLA::Matrix<N_STATE, 1>& xHnnm1) {
  float tmp1, tmp2;
  for (int j = 0; j < N_STATE; j++) {
    // measurements depend on x, y, theta and z only (not on the velocities);
    // with ESTIMATE_Z off the z column stays 0, so z is never corrected
    if (j != IX && j != IY && j != ITH && !(ESTIMATE_Z && j == IZ))
      continue;
    BLA::Matrix<N_STATE, 1> xp = xHnnm1;
    BLA::Matrix<N_STATE, 1> xm = xHnnm1;
    xp(j) += eps;
    xm(j) -= eps;
    // cos / sin of the heading once per shifted state, not once per LED and PD
    const float cosP = cosf(xp(ITH)), sinP = sinf(xp(ITH));
    const float cosM = cosf(xm(ITH)), sinM = sinf(xm(ITH));
    for (int k = 0; k < N_LED; k++)
      for (int l = 0; l < N_PD; l++) {
        if (!LED_ON[k]) { Jn(N_PD * k + l, j) = 0; continue; }  // LED off: no influence
        // RSS_OFFSET is the same on both sides, so it drops out here
        tmp1 = PtxGamma[k] * PD_GAIN[l] * pathLossCS(k, l, xp(IX), xp(IY), xp(IZ), cosP, sinP);
        tmp2 = PtxGamma[k] * PD_GAIN[l] * pathLossCS(k, l, xm(IX), xm(IY), xm(IZ), cosM, sinM);
        Jn(N_PD * k + l, j) = (tmp1 - tmp2) / (2.0f * eps);
      }
  }
}

// EKF correction, one RSS value at a time (see EKF_SEQUENTIAL). Starts from the
// prediction (xHnnm1, Pnnm1) and leaves the result in xHnm1nm1 / Pnm1nm1.
// For value i with Jacobian row h and noise sigma2:
//   S = h P h' + sigma2,  K = P h' / S
//   x = x + K * (zn(i) - zHn(i) - h (x - xHnnm1))   innovation against the model
//                                                    linearised at xHnnm1
//   P = (I - K h) P (I - K h)' + K sigma2 K'         Joseph form, as before
// Values of LEDs that are off are skipped (their rows of Jn are 0).
void ekfUpdateSequential() {
  float h[N_STATE], Ph[N_STATE], hP[N_STATE], K[N_STATE], Mh[N_STATE];
  float M[N_STATE][N_STATE];
  xHnm1nm1 = xHnnm1;
  Pnm1nm1 = Pnnm1;
  for (int f = 0; f < N_LED; f++) {
    if (!LED_ON[f]) continue;
    for (int g = 0; g < N_PD; g++) {
      const int i = N_PD * f + g;
      float S = sigma2;
      float innov = zn(i) - zHn(i);
      for (int a = 0; a < N_STATE; a++) h[a] = Jn(i, a);
      for (int a = 0; a < N_STATE; a++) {
        float s1 = 0, s2 = 0;
        for (int b = 0; b < N_STATE; b++) {
          s1 += Pnm1nm1(a, b) * h[b];  // P h'
          s2 += h[b] * Pnm1nm1(b, a);  // h P
        }
        Ph[a] = s1;
        hP[a] = s2;
      }
      for (int a = 0; a < N_STATE; a++) {
        S += h[a] * Ph[a];
        innov -= h[a] * (xHnm1nm1(a) - xHnnm1(a));
      }
      for (int a = 0; a < N_STATE; a++) {
        K[a] = Ph[a] / S;
        xHnm1nm1(a) += K[a] * innov;
      }
      // M = (I - K h) P
      for (int a = 0; a < N_STATE; a++)
        for (int b = 0; b < N_STATE; b++) M[a][b] = Pnm1nm1(a, b) - K[a] * hP[b];
      // P = M (I - K h)' + K sigma2 K' = M - (M h') K' + sigma2 K K'
      for (int a = 0; a < N_STATE; a++) {
        float s1 = 0;
        for (int b = 0; b < N_STATE; b++) s1 += M[a][b] * h[b];
        Mh[a] = s1;
      }
      for (int a = 0; a < N_STATE; a++)
        for (int b = 0; b < N_STATE; b++) Pnm1nm1(a, b) = M[a][b] - Mh[a] * K[b] + sigma2 * K[a] * K[b];
    }
  }
}

float boundAngle(float a) {
  while (a > M_PI) a -= 2.0f * M_PI;
  while (a < -M_PI) a += 2.0f * M_PI;
  return a;
}

//----------------------------------------------------------------------
// Output: every line goes to USB serial and, with USE_WIFI, to the WiFi
// clients. Print to `out` instead of `Serial` (same print() / println()).
#if USE_WIFI
// Lines waiting for the WiFi clients, already framed as SSE events
// ("data: <line>\n\n"). Each client sends from its own position; one that
// falls more than a ring behind skips to the newest event. Never blocks.
const uint32_t TX_RING = 8192;            // bytes, power of 2 (~1.5 s of mode 3 output)
char txRing[TX_RING];
uint32_t txHead = 0;                      // bytes ever added
uint32_t txEventStart = 0;                // txHead where the newest event starts
void ringPut(const char* s, int n) {
  for (int i = 0; i < n; i++) txRing[(txHead++) & (TX_RING - 1)] = s[i];
}
void pushEvent(const char* line, int n) {
  txEventStart = txHead;
  ringPut("data: ", 6);
  ringPut(line, n);
  ringPut("\n\n", 2);
}
#endif

class Out : public Print {
 public:
  size_t write(uint8_t c) override { return write(&c, 1); }
  size_t write(const uint8_t* buf, size_t n) override {
    Serial.write(buf, n);  // returns at once when no computer has the port open
#if USE_WIFI
    for (size_t i = 0; i < n; i++) {
      const char c = (char)buf[i];
      if (c == '\r') continue;
      if (c != '\n') {
        if (len < (int)sizeof(line)) line[len++] = c;
        continue;
      }
      pushEvent(line, len);
      len = 0;
    }
#endif
    return n;
  }
 private:
#if USE_WIFI
  char line[400];  // longest line: the RSS line, 27 values (~220 chars)
  int len = 0;
#endif
};
Out out;

// Commands from the web page, one per line (USB serial or WiFi /cmd):
//   LED <number> <0|1>     e.g. "LED 4 0" stops using LED 4, "LED 4 1" uses it again
//   TIMING <0|1>           print a "# T ..." line with the loop timing after each loop
//   WIFI                   print the "# WIFI ..." line again
// Each accepted command is answered with "# LED <number> <0|1>" or
// "# TIMING <0|1>" (the web page ignores lines that start with #).
void printWifiInfo();
void handleCommand(const char* buf) {
  int num, on;
  if (sscanf(buf, "LED %d %d", &num, &on) == 2) {
    for (int k = 0; k < N_LED; k++) {
      if (LED_NUM[k] != num) continue;
      LED_ON[k] = (on != 0);
      out.print("# LED "); out.print(num); out.print(" "); out.println(LED_ON[k] ? 1 : 0);
    }
  } else if (sscanf(buf, "TIMING %d", &on) == 1) {
    PRINT_TIMING = (on != 0);
    out.print("# TIMING "); out.println(PRINT_TIMING ? 1 : 0);
  } else if (strcmp(buf, "WIFI") == 0) {
    printWifiInfo();
  }
}

void readCommands() {
  static char buf[32];
  static int len = 0;
  while (Serial.available() > 0) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c != '\n') {
      if (len < (int)sizeof(buf) - 1) buf[len++] = c;
      continue;
    }
    buf[len] = 0;
    len = 0;
    handleCommand(buf);
  }
}

//----------------------------------------------------------------------
// WiFi access point + tiny HTTP server (core 0 only: arduino-pico allows
// WiFi code on core 0 only without FreeRTOS). wifiPoll() never waits for
// the network; loop() calls it while it waits for the next sample window,
// which is idle time (about 20 ms of every 50 ms loop).
#if USE_WIFI
static_assert(sizeof(WIFI_AP_PASS) - 1 >= 8, "WIFI_AP_PASS needs at least 8 characters (WPA2)");
const IPAddress WIFI_IP(192, 168, 42, 1);  // set explicitly: the core's default differs between versions
WiFiServer server(80);
const int MAX_CONN = 4;                   // the Pico W access point takes 4 stations
struct Conn {
  WiFiClient c;
  bool sse;            // true = /events stream, else still reading the request
  uint32_t pos;        // next ring byte to send (sse)
  char req[256];       // request so far
  int len;
  unsigned long since; // millis() when accepted
};
Conn conns[MAX_CONN];
bool wifiOk = false;

void printWifiInfo() {
  out.print("# WIFI ap="); out.print(WIFI_AP_SSID);
  out.print(wifiOk ? " ip=" : " FAILED ip="); out.println(WiFi.softAPIP());
}

void wifiBegin() {
  WiFi.mode(WIFI_AP);
  WiFi.softAPConfig(WIFI_IP, WIFI_IP, IPAddress(255, 255, 255, 0));
  wifiOk = WiFi.beginAP(WIFI_AP_SSID, WIFI_AP_PASS) == WL_CONNECTED;
  server.begin();
  server.setNoDelay(true);
  printWifiInfo();  // lost on serial if no computer is listening yet: send "WIFI" to see it
}

// Every reply lets a page opened from file:// read it (CORS) and allows
// Chrome's private-network check (the robot is on a local address).
const char CORS[] = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Private-Network: true\r\n";

// (slot numbers, not Conn&: the Arduino IDE puts its own function
// prototypes above struct Conn)
void replyAndClose(int slot, const char* status, const char* extra, const char* body) {
  Conn& k = conns[slot];
  char head[400];
  const int n = snprintf(head, sizeof(head),
    "HTTP/1.1 %s\r\n%s%sContent-Type: text/plain\r\nContent-Length: %u\r\nConnection: close\r\n\r\n%s",
    status, CORS, extra, (unsigned)strlen(body), body);
  k.c.write((const uint8_t*)head, n < (int)sizeof(head) ? n : (int)sizeof(head) - 1);
  k.c.stop();
}

// "%20" and "+" -> " "; stops at '&', ' ' or the end
void urlDecode(const char* s, char* dst, int size) {
  int n = 0;
  while (*s && *s != '&' && *s != ' ' && n < size - 1) {
    if (*s == '+') { dst[n++] = ' '; s++; }
    else if (*s == '%' && isxdigit((unsigned char)s[1]) && isxdigit((unsigned char)s[2])) {
      const char hex[3] = { s[1], s[2], 0 };
      dst[n++] = (char)strtol(hex, NULL, 16);
      s += 3;
    } else dst[n++] = *s++;
  }
  dst[n] = 0;
}

void handleRequest(int slot) {
  Conn& k = conns[slot];
  const char* r = k.req;
  if (strncmp(r, "OPTIONS ", 8) == 0) {
    replyAndClose(slot, "204 No Content",
      "Access-Control-Allow-Methods: GET\r\nAccess-Control-Allow-Headers: *\r\n", "");
  } else if (strncmp(r, "GET /events", 11) == 0) {
    char head[300];
    const int n = snprintf(head, sizeof(head),
      "HTTP/1.1 200 OK\r\n%sContent-Type: text/event-stream\r\nCache-Control: no-cache\r\n"
      "Connection: keep-alive\r\n\r\nretry: 1000\n\n", CORS);
    k.c.write((const uint8_t*)head, n);
    k.sse = true;
    k.pos = txHead;  // only lines from now on
  } else if (strncmp(r, "GET /cmd?", 9) == 0) {
    const char* p = strstr(r + 9, "c=");
    char cmd[32];
    urlDecode(p ? p + 2 : "", cmd, sizeof(cmd));
    replyAndClose(slot, "204 No Content", "", "");
    handleCommand(cmd);
  } else if (strncmp(r, "GET / ", 6) == 0) {
    replyAndClose(slot, "200 OK", "", "RA robot ok\n");
  } else {
    replyAndClose(slot, "404 Not Found", "", "not found\n");
  }
}

void wifiPoll() {
  WiFiClient nc = server.accept();
  if (nc) {
    int i = 0;
    while (i < MAX_CONN && conns[i].c.connected()) i++;
    if (i == MAX_CONN) nc.stop();  // all slots busy
    else {
      nc.setNoDelay(true);
      conns[i].c = nc;
      conns[i].sse = false;
      conns[i].len = 0;
      conns[i].since = millis();
    }
  }
  for (int i = 0; i < MAX_CONN; i++) {
    Conn& k = conns[i];
    if (!k.c.connected()) continue;
    if (!k.sse) {
      while (k.c.available() > 0 && k.len < (int)sizeof(k.req) - 1) k.req[k.len++] = (char)k.c.read();
      k.req[k.len] = 0;
      if (strstr(k.req, "\r\n\r\n") || k.len == (int)sizeof(k.req) - 1) handleRequest(i);
      else if (millis() - k.since > 2000) k.c.stop();  // never finished its request
      continue;
    }
    while (k.c.available() > 0) k.c.read();           // nothing expected from an SSE client
    if (txHead - k.pos > TX_RING - 512) k.pos = txEventStart;  // too slow: skip to the newest event
    const uint32_t pending = txHead - k.pos;
    const int room = k.c.availableForWrite();
    if (!pending || room <= 0) continue;
    const uint32_t off = k.pos & (TX_RING - 1);
    uint32_t n = pending;
    if (n > (uint32_t)room) n = room;
    if (n > TX_RING - off) n = TX_RING - off;           // up to the end of the ring; the rest next time
    k.pos += k.c.write((const uint8_t*)txRing + off, n);
  }
}
#else
void printWifiInfo() {}
#endif

//----------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  analogReadResolution(10);
  initEkf();
  initDemod();
#if USE_WIFI
  wifiBegin();  // before the sampling timer starts
#endif
  hardware_alarm_claim(0);
  add_repeating_timer_us(-40, timer_callback, NULL, &timer);
}

void loop() {
  float RSS[N_LED][N_PD] = {};  // stays 0 for LEDs that are off
  unsigned long time1 = millis();
  unsigned long tStart = micros();  // for the "# T" timing line

  readCommands();  // apply any LED on/off commands from the web page

  // Wait until UPDATE_EVERY new samples have arrived since the last window
  // (and, at power-up, until the ring holds a whole window). If the previous
  // loop took longer than that, this returns at once: the rate drops instead
  // of the windows falling behind the newest samples.
  static uint32_t lastEnd = 0;
  uint32_t end;
#if USE_WIFI
  wifiPoll();   // at least once per loop, even when there is no time to wait
#endif
  do {
    end = sampleCount;  // one 32-bit read: atomic on the Cortex-M0+
#if USE_WIFI
    if (end < N || end < lastEnd + (uint32_t)UPDATE_EVERY) wifiPoll();  // serve WiFi while idle
#endif
  } while (end < N || end < lastEnd + (uint32_t)UPDATE_EVERY);
  lastEnd = end;
  // the window is the N samples before slot `end`
  const int winStart = (int)((end - (uint32_t)N) % (uint32_t)RING_N);
  unsigned long tSampled = micros();

  // Correlate each photodiode with sin and cos at each lit LED's frequency.
  // Was, per sample (float, sin() and cos() called 2 * N times per LED):
  //   angle = 2.0f * M_PI * Fref[f] * i / samplingFreq;
  //   corrSin[f][g] += sampleTemp[g][i] * sin(angle);   (and cos)
  //   RSS[f][g] = (1.0f)/N * sqrt(corrSin^2 + corrCos^2);
  // Now the same sums with the tables of initDemod() and integers only.
  for (int f = 0; f < N_LED; f++) {
    if (!LED_ON[f]) continue;  // skip LEDs that are off (saves time; RSS stays 0)
    int64_t accSin[N_PD] = {}, accCos[N_PD] = {};
    const int step = lutStep[f];
    int idx = 0, ri = winStart;
    for (int i = 0; i < N; i++) {
      const int32_t s = sinQ[idx];
      const int32_t c = cosQ[idx];
      for (int g = 0; g < N_PD; g++) {
        const int32_t x = ring[g][ri];  // 0..1023, so x * s fits in 32 bits
        accSin[g] += x * s;
        accCos[g] += x * c;
      }
      idx += step;
      if (idx >= LUT_N) idx -= LUT_N;
      if (++ri == RING_N) ri = 0;
    }
    for (int g = 0; g < N_PD; g++) {
      const double cs = (double)accSin[g], cc = (double)accCos[g];
      RSS[f][g] = (float)(sqrt(cs * cs + cc * cc) / ((double)N * LUT_SCALE));
    }
  }
  unsigned long tDemod = micros();

  for (int f = 0; f < N_LED; f++)
    for (int g = 0; g < N_PD; g++) {
      zn(N_PD*f+g) = RSS[f][g];
      // Serial.print("RSS"); 
      if (mode == 1 || mode == 3){
        out.print(RSS[f][g], 4);  // 4 decimals: the default 2 is too coarse for calibration
        out.print(", ");
      }
    }
  if (mode == 1 || mode == 3){  
    out.println("");
  }

  // Use the real time since the previous update as T (it was fixed at 0.2 s
  // when a loop took about 0.33 s, so the velocity was off; now about 0.05 s).
  // The first loop keeps the default.
  static unsigned long lastUpdate = 0;
  if (lastUpdate != 0) T = (time1 - lastUpdate) / 1000.0f;
  lastUpdate = time1;
  for (int i = 0; i < N_STATE; i += 2) A(i, i + 1) = T;
  for (int i = 0; i < N_STATE; i++) Q(i, i) = Q0[i] * T / T_REF;  // see T_REF

  //ONE ITERATION OF EKF/UKF
  //Prediction step
  xHnnm1 = A * xHnm1nm1;
  Pnnm1 = A * Pnm1nm1 * ~A + Q;

  //Correction step
  computeJacobian(xHnnm1);
  const float cosTh = cosf(xHnnm1(ITH)), sinTh = sinf(xHnnm1(ITH));
  for (int f = 0; f < N_LED; f++)
    for (int g = 0; g < N_PD; g++)
      // LED off: predicted = measured, so its innovation is 0
      zHn(N_PD * f + g) = LED_ON[f] ? PtxGamma[f] * PD_GAIN[g] * pathLossCS(f, g, xHnnm1(IX), xHnnm1(IY), xHnnm1(IZ), cosTh, sinTh) + RSS_OFFSET
                                    : zn(N_PD * f + g);
  if (EKF_SEQUENTIAL) {
    ekfUpdateSequential();
  } else {
    Kn = Pnnm1 * ~Jn * Inverse(R + Jn * Pnnm1 * ~Jn);
    xHnm1nm1 = xHnnm1 + Kn * (zn - zHn);
    // Pnm1nm1 = (I6 - Kn*Jn) * Pnnm1;
    Pnm1nm1 = (I6 - Kn*Jn) * Pnnm1 * ~(I6 - Kn*Jn) + Kn * R * ~Kn;
  }
  xHnm1nm1(ITH) = boundAngle(xHnm1nm1(ITH));
  if (ESTIMATE_Z) {
    // keep z in the range where the model holds; stop vz pushing past a limit
    if (xHnm1nm1(IZ) < Z_MIN) { xHnm1nm1(IZ) = Z_MIN; if (xHnm1nm1(IZ + 1) < 0) xHnm1nm1(IZ + 1) = 0; }
    if (xHnm1nm1(IZ) > Z_MAX) { xHnm1nm1(IZ) = Z_MAX; if (xHnm1nm1(IZ + 1) > 0) xHnm1nm1(IZ + 1) = 0; }
  } else {
    xHnm1nm1(IZ) = 0;
    xHnm1nm1(IZ + 1) = 0;
  }
  //Serial.print("Covariance"); Serial.println(Pnm1nm1);
  unsigned long tEkf = micros();
  if (mode == 2 || mode == 3){
    // Web format:  Quadrant <n>: <x cm>, <y cm>, <angle deg>, <z cm>
    // (the page also accepts the old line without z, and then takes z = 0)
    float xcm = xHnm1nm1(IX) * 100.0;
    float ycm = xHnm1nm1(IY) * 100.0;
    float deg = xHnm1nm1(ITH) / M_PI * 180.0;
    float zcm = xHnm1nm1(IZ) * 100.0;
    int q = (xcm >= 0) ? (ycm >= 0 ? 1 : 4) : (ycm >= 0 ? 2 : 3);
    out.print("Quadrant "); out.print(q); out.print(": ");
    out.print(xcm); out.print(", ");
    out.print(ycm); out.print(", ");
    out.print(deg); out.print(", ");
    out.println(zcm);
  }
  if (PRINT_TIMING) {
    // ms spent waiting for the window, demodulating and in the EKF (which
    // here includes printing the RSS line in mode 1 / 3); total = the whole
    // loop up to here, with the position line. total is the update period.
    // wait = time spent waiting for the next window (sampling runs all the time)
    out.print("# T wait="); out.print((tSampled - tStart) / 1000.0f, 1);
    out.print(" demod="); out.print((tDemod - tSampled) / 1000.0f, 1);
    out.print(" ekf="); out.print((tEkf - tDemod) / 1000.0f, 1);
    out.print(" total="); out.println((micros() - tStart) / 1000.0f, 1);
  }
//
  unsigned long time2 = millis();
  // Serial.println(time2-time1);
  // delayMicroseconds(200000);  //0.2s
}
