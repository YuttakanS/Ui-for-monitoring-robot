#include "pico/stdlib.h"
#include "pico/time.h"
#include <math.h>
#include <BasicLinearAlgebra.h>

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
volatile int sampleTemp[N_PD][N];
volatile int sampleIndex = 0;
volatile bool isSampling = false;

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
// LED 7, 8, 1, 2: fitted 2026-11-19 together with PD_GAIN and RSS_OFFSET
// below (calibrate.js fitModel(), calib/ra_calib_20261119_130953.csv, 8 poses,
// theta = 0, m = 1, be = 55 deg). LED 4, 5 (not lit) and LED 0, 3, 6 (off) are
// not calibrated.
// To go back to the model without PD_GAIN / RSS_OFFSET (x / y about 1-2 cm on
// the board with ESTIMATE_Z = false), use PD_GAIN = 1, 1, 1, RSS_OFFSET = 0 and
//   { 0.490f, 0.490f, 0.476f, 0.457f, 0.562f, 0.525f, 0.460f, 0.460f, 0.460f }
// (with be = 60 deg the gammas were 0.453, 0.436, 0.536, 0.504).
const float PtxGamma[N_LED] = { 0.490f, 0.490f, 0.447f, 0.435f, 0.538f, 0.506f, 0.460f, 0.460f, 0.460f };
// Photodiode gain relative to PD 0 (pin GP28). The calibration data read PD 0
// 12-21 % above the model for every LED; PD 1 and 2 are about 8-9 % lower.
const float PD_GAIN[N_PD] = { 1.000f, 0.917f, 0.906f };
// Added to every RSS of a lit LED: reflections and the noise floor of the
// demodulation. Far LEDs (> 1.25 m) read about 21 % above the model without it.
// With these two, the model misfit fell from 12-18 % to 8-10 % and x / y on
// the PC (leave one pose out) from 5.9 to 3.6 cm.
const float RSS_OFFSET = 0.0689f;
const float eps = 0.01; //0.01;
const float sigma2 = 0.01; //0.1, 0.4, 0.1, 0.005; 
// const float q = 0.01;
int mode = 2; //1 is RSS only. 2 is the coordinate.
// true = print how long each part of a loop took, as a "# T ..." line (the web
// pages skip lines that start with #). Switched with the command "TIMING <0|1>".
bool PRINT_TIMING = false;

BLA::Matrix<N_LED, 3> p = { 0, 0, 0.920, //0.93 - 0.03 - 0.01   LED4
                            -0.5, 0, 0.920,                  // LED5
                            0, 0.5, 0.920,                   // LED7
                            -0.5, 0.5, 0.920,                // LED8
                            0, -0.5, 0.920,                  // LED1
                            -0.5, -0.5, 0.920,               // LED2
                            0.5, -0.5, 0.920,                // LED0
                            0.5, 0, 0.920,                   // LED3
                            0.5, 0.5, 0.920 };               // LED6

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
// z is kept in this range (m): a little below the floor for noise, and well
// below the LEDs, where the path-loss model blows up (distance -> 0).
const float Z_MIN = -0.05f, Z_MAX = 0.80f;

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

// Same values as the 6-state version for x, y and theta; z / vz use the same
// as x / y. (Earlier tuning tries are in git history.)
void initEkf() {
  //                          x     vx    y     vy    th    om    z     vz
  const float P0[N_STATE] = { 0.01, 1,    0.01, 1,    0.01, 1,    0.01, 1    };
  // Q for x, y, z and their velocities was 1e-6: the position lagged, ran
  // about 8 cm past a robot that stopped and took about 10 s to come back
  // (move_straight test, 2026-11-19). 1e-4 settles in about 2-3 s with
  // under 1 cm of jitter when still (EKF replica on the PC).
  const float Q0[N_STATE] = { 1e-4, 1e-4, 1e-4, 1e-4, 1e-2, 1e-2, 1e-4, 1e-4 };
  for (int i = 0; i < N_STATE; i++) {
    A(i, i) = 1.0;
    I6(i, i) = 1.0;
    Pnm1nm1(i, i) = P0[i];
    Q(i, i) = Q0[i];
  }
  for (int i = 0; i < N_STATE; i += 2) A(i, i + 1) = T;  // position += T * velocity
  for (int i = 0; i < N_Z; i++) R(i, i) = sigma2;
}

//----------------------------------------------------------------------
// callback called every 40 microseconds
bool timer_callback(repeating_timer_t* t) {
  if (isSampling) {
    if (sampleIndex < N) {
      for (int g = 0; g < N_PD; g++)
        sampleTemp[g][sampleIndex] = analogRead(pins[g]);
      sampleIndex++;
    } else {
      isSampling = false;  // Stop sampling when all 2500 sets are collected
    }
  }
  return true;
}

float vectorNorm(const BLA::Matrix<3, 1>& z) {
  return sqrt(z(0, 0) * z(0, 0) + z(1, 0) * z(1, 0) + z(2, 0) * z(2, 0));
}

float pathLossWithoutGamma(int k, int l, float x0, float y0, float z0, float t0) {
  // k = LED index, l = PD index; (x0, y0, z0) = robot position, t0 = heading
  float dk, cosPhikl, cosPsikl;
  BLA::Matrix<3, 1> p0 = { x0, y0, z0 };  // z0 was fixed at 0 before z was estimated
  BLA::Matrix<3, 1> pk = { p(k, 0), p(k, 1), p(k, 2) };
  BLA::Matrix<3, 1> vl = { v(l, 0), v(l, 1), v(l, 2) };
  BLA::Matrix<3, 3> Omega0 = { cos(t0), sin(t0), 0.0, -sin(t0), cos(t0), 0.0, 0.0, 0.0, 1.0 };
  BLA::Matrix<1, 1> tmp;
  dk = vectorNorm(p0 - pk);
  //Serial.println(dk);
  tmp = ~(p0 - pk) * uk / dk;
  cosPhikl = tmp(0, 0);
  tmp = ~(pk - p0) * (Omega0 * vl) / dk;
  cosPsikl = tmp(0, 0);
  if (cosPsikl > cos(FoV))
    // Callers multiply by PtxGamma[k], so it must not be applied here as well.
    // Old line (gamma applied twice):
    // return PtxGamma[k] * (m + 1) * pow(cosPhikl, m) * cosPsikl / pow(dk, 2);
    return (m + 1) * pow(cosPhikl, m) * cosPsikl / pow(dk, 2);
  else
    return 0;
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
    for (int k = 0; k < N_LED; k++)
      for (int l = 0; l < N_PD; l++) {
        if (!LED_ON[k]) { Jn(N_PD * k + l, j) = 0; continue; }  // LED off: no influence
        // RSS_OFFSET is the same on both sides, so it drops out here
        tmp1 = PtxGamma[k] * PD_GAIN[l] * pathLossWithoutGamma(k, l, xp(IX), xp(IY), xp(IZ), xp(ITH));
        tmp2 = PtxGamma[k] * PD_GAIN[l] * pathLossWithoutGamma(k, l, xm(IX), xm(IY), xm(IZ), xm(ITH));
        Jn(N_PD * k + l, j) = (tmp1 - tmp2) / (2.0f * eps);
      }
  }
}

float boundAngle(float a) {
  while (a > M_PI) a -= 2.0f * M_PI;
  while (a < -M_PI) a += 2.0f * M_PI;
  return a;
}

// Commands from the web page over USB serial, one per line:
//   LED <number> <0|1>     e.g. "LED 4 0" stops using LED 4, "LED 4 1" uses it again
//   TIMING <0|1>           print a "# T ..." line with the loop timing after each loop
// Each accepted command is answered with "# LED <number> <0|1>" or
// "# TIMING <0|1>" (the web page ignores lines that start with #).
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
    int num, on;
    if (sscanf(buf, "LED %d %d", &num, &on) == 2) {
      for (int k = 0; k < N_LED; k++) {
        if (LED_NUM[k] != num) continue;
        LED_ON[k] = (on != 0);
        Serial.print("# LED "); Serial.print(num); Serial.print(" "); Serial.println(LED_ON[k] ? 1 : 0);
      }
    } else if (sscanf(buf, "TIMING %d", &on) == 1) {
      PRINT_TIMING = (on != 0);
      Serial.print("# TIMING "); Serial.println(PRINT_TIMING ? 1 : 0);
    }
  }
}

//----------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  analogReadResolution(10);
  initEkf();
  hardware_alarm_claim(0);
  add_repeating_timer_us(-40, timer_callback, NULL, &timer);
}

void loop() {
  float corrSin[N_LED][N_PD] = {};
  float corrCos[N_LED][N_PD] = {};
  float RSS[N_LED][N_PD];
  float angle;
  unsigned long time1 = millis();
  unsigned long tStart = micros();  // for the "# T" timing line

  readCommands();  // apply any LED on/off commands from the web page

  sampleIndex = 0;
  isSampling = true;
  while (isSampling) {
    // Do nothing, wait for all samples to be updated.
  }
  unsigned long tSampled = micros();

  // sin/cos depend only on the LED frequency and the sample index, so work
  // them out once and reuse them for all 3 photodiodes (as in copy2).
  for (int f = 0; f < N_LED; f++) {
    if (!LED_ON[f]) continue;  // skip LEDs that are off (saves time; RSS stays 0)
    for (int i = 0; i < N; i++) {
      angle = 2.0f * M_PI * Fref[f] * i / samplingFreq;
      float s = sin(angle);
      float c = cos(angle);
      for (int g = 0; g < N_PD; g++) {
        corrSin[f][g] += sampleTemp[g][i] * s;
        corrCos[f][g] += sampleTemp[g][i] * c;
      }
    }
  }
  unsigned long tDemod = micros();

  for (int f = 0; f < N_LED; f++)
    for (int g = 0; g < N_PD; g++) {
      RSS[f][g] = (1.0f)/N * sqrt(corrSin[f][g] * corrSin[f][g] + corrCos[f][g] * corrCos[f][g]); //
      zn(N_PD*f+g) = RSS[f][g];
      // Serial.print("RSS"); 
      if (mode == 1 || mode == 3){
        Serial.print(RSS[f][g], 4);  // 4 decimals: the default 2 is too coarse for calibration
        Serial.print(", ");
      }
    }
  if (mode == 1 || mode == 3){  
    Serial.println("");
  }

  // Use the real time since the previous update as T (it was fixed at 0.2 s,
  // but one loop takes about 0.33 s, so the velocity was off). The first
  // loop keeps the default.
  static unsigned long lastUpdate = 0;
  if (lastUpdate != 0) T = (time1 - lastUpdate) / 1000.0f;
  lastUpdate = time1;
  for (int i = 0; i < N_STATE; i += 2) A(i, i + 1) = T;

  //ONE ITERATION OF EKF/UKF
  //Prediction step
  xHnnm1 = A * xHnm1nm1;
  Pnnm1 = A * Pnm1nm1 * ~A + Q;

  //Correction step
  computeJacobian(xHnnm1);
  Kn = Pnnm1 * ~Jn * Inverse(R + Jn * Pnnm1 * ~Jn);
  for (int f = 0; f < N_LED; f++)
    for (int g = 0; g < N_PD; g++)
      // LED off: predicted = measured, so its innovation is 0
      zHn(N_PD * f + g) = LED_ON[f] ? PtxGamma[f] * PD_GAIN[g] * pathLossWithoutGamma(f, g, xHnnm1(IX), xHnnm1(IY), xHnnm1(IZ), xHnnm1(ITH)) + RSS_OFFSET
                                    : zn(N_PD * f + g);
  xHnm1nm1 = xHnnm1 + Kn * (zn - zHn);
  // Pnm1nm1 = (I6 - Kn*Jn) * Pnnm1; 
  Pnm1nm1 = (I6 - Kn*Jn) * Pnnm1 * ~(I6 - Kn*Jn) + Kn * R * ~Kn;
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
    Serial.print("Quadrant "); Serial.print(q); Serial.print(": ");
    Serial.print(xcm); Serial.print(", ");
    Serial.print(ycm); Serial.print(", ");
    Serial.print(deg); Serial.print(", ");
    Serial.println(zcm);
  }
  if (PRINT_TIMING) {
    // ms spent sampling, demodulating (including printing RSS in mode 1 / 3)
    // and in the EKF; total = the whole loop up to here, with the printing
    // above. The time between two lines is the real update period.
    Serial.print("# T sample="); Serial.print((tSampled - tStart) / 1000.0f, 1);
    Serial.print(" demod="); Serial.print((tDemod - tSampled) / 1000.0f, 1);
    Serial.print(" ekf="); Serial.print((tEkf - tDemod) / 1000.0f, 1);
    Serial.print(" total="); Serial.println((micros() - tStart) / 1000.0f, 1);
  }
//
  unsigned long time2 = millis();
  // Serial.println(time2-time1);
  // delayMicroseconds(200000);  //0.2s
}
