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
const int N_STATE = 6;
const int pins[N_PD] = { 28, 27, 26 };

// Same order as p:           LED4     LED5     LED7     LED8     LED1     LED2     LED0     LED3     LED6
const float Fref[N_LED] = { 2300.0f, 2900.0f, 3700.0f, 4100.0f, 1300.0f, 1700.0f, 1100.0f, 1900.0f, 3100.0f };
volatile int sampleTemp[N_PD][N];
volatile int sampleIndex = 0;
volatile bool isSampling = false;

//VARIBLES OF EKF/UKF
const float m = 1.0;  //Lambertian order
const float FoV = M_PI / 2;
const float T = 0.2;
const float al[N_PD] = { 0, 2.0*M_PI/3.0, -2.0*M_PI/3.0 };
const float be = M_PI / 3;
// const float PtxGamma[N_LED] = { 0.46f, 0.41f, 0.55f, 0.51f };  
// Which LEDs the EKF uses (same order as p). An LED set to false is not
// demodulated and adds nothing to the update. These are the values at power-up;
// the web page can change them at run time (see readCommands()).
const int LED_NUM[N_LED] = {     4,     5,    7,    8,    1,    2,    0,    3,    6 };  // LED number per row of p
bool LED_ON[N_LED]       = { false, false, true, true, true, true, true, true, true };  // LED4, LED5 off at start
// LED1, LED2, LED0, LED3, LED6 = 0.46 for now (not calibrated yet)
const float PtxGamma[N_LED] = { 0.49f, 0.49f, 0.46f, 0.46f, 0.46f, 0.46f, 0.46f, 0.46f, 0.46f };
const float eps = 0.01; //0.01;
const float sigma2 = 0.01; //0.1, 0.4, 0.1, 0.005; 
// const float q = 0.01;
int mode = 2; //1 is RSS only. 2 is the coordinate.

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
BLA::Matrix<6, 1> xHnm1nm1 = { 0.0 };
BLA::Matrix<6, 1> xHnnm1 = { 0.0 };
BLA::Matrix<N_Z, 1> zn = { 0.0 };
BLA::Matrix<N_Z, 1> zHn = { 0.0 };
BLA::Matrix<6, 6> A = { 1, T, 0, 0, 0, 0,
                        0, 1, 0, 0, 0, 0,
                        0, 0, 1, T, 0, 0,
                        0, 0, 0, 1, 0, 0,
                        0, 0, 0, 0, 1, T,
                        0, 0, 0, 0, 0, 1 };
BLA::Matrix<N_Z, 6> Jn = { 0.0 };
BLA::Matrix<6, N_Z> Kn = { 0.0 };
BLA::Matrix<6, 6> Pnm1nm1 = { 0.01, 0, 0, 0, 0, 0,
                              0, 1, 0, 0, 0, 0,
                              0, 0, 0.01, 0, 0, 0,
                              0, 0, 0, 1, 0, 0,
                              0, 0, 0, 0, 0.01, 0,
                              0, 0, 0, 0, 0, 1 };
// BLA::Matrix<6, 6> Pnm1nm1 = { 0.01, 0, 0, 0, 0, 0,
//                               0, 0.01, 0, 0, 0, 0,
//                               0, 0, 0.01, 0, 0, 0,
//                               0, 0, 0, 0.01, 0, 0,
//                               0, 0, 0, 0, 0.01, 0,
//                               0, 0, 0, 0, 0, 0.01
//                             };
BLA::Matrix<6, 6> Pnnm1 = { 0.0 };
// BLA::Matrix<6, 6> Q = { 0.01, 0, 0, 0, 0, 0,
//                         0, 0.01, 0, 0, 0, 0,
//                         0, 0, 0.01, 0, 0, 0,
//                         0, 0, 0, 0.01, 0, 0,
//                         0, 0, 0, 0, 0.01, 0,
//                         0, 0, 0, 0, 0, 0.01 };
BLA::Matrix<6, 6> Q = { 1e-6, 0, 0, 0, 0, 0,
                        0, 1e-6, 0, 0, 0, 0,
                        0, 0, 1e-6, 0, 0, 0,
                        0, 0, 0, 1e-6, 0, 0,
                        0, 0, 0, 0, 1e-2, 0,
                        0, 0, 0, 0, 0, 1e-2};
// BLA::Matrix<6, 6> Q = { 1e-10, 0, 0, 0, 0, 0,
//                         0, 1e-6, 0, 0, 0, 0,
//                         0, 0, 1e-10, 0, 0, 0,
//                         0, 0, 0, 1e-6, 0, 0,
//                         0, 0, 0, 0, 1e-2, 0,
//                         0, 0, 0, 0, 0, 1e-2
//                       };
BLA::Matrix<N_Z, N_Z> R = { 0.0 };
BLA::Matrix<6, 6> I6 = { 1.0, 0, 0, 0, 0, 0,
                        0, 1.0, 0, 0, 0, 0,
                        0, 0, 1.0, 0, 0, 0,
                        0, 0, 0, 1.0, 0, 0,
                        0, 0, 0, 0, 1.0, 0,
                        0, 0, 0, 0, 0, 1.0 };
//BLA::Matrix<6, 6> I6 = { 0.0 };

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

float pathLossWithoutGamma(int k, int l, float x0, float y0, float t0) {
  // k = LED index, l = PD index
  float dk, cosPhikl, cosPsikl;
  BLA::Matrix<3, 1> p0 = { x0, y0, 0 };
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
    if (j != 0 && j != 2 && j != 4)
      continue;
    BLA::Matrix<N_STATE, 1> xp = xHnnm1;
    BLA::Matrix<N_STATE, 1> xm = xHnnm1;
    xp(j) += eps;
    xm(j) -= eps;
    for (int k = 0; k < N_LED; k++)
      for (int l = 0; l < N_PD; l++) {
        if (!LED_ON[k]) { Jn(N_PD * k + l, j) = 0; continue; }  // LED off: no influence
        tmp1 = PtxGamma[k] * pathLossWithoutGamma(k, l, xp(0), xp(2), xp(4));
        tmp2 = PtxGamma[k] * pathLossWithoutGamma(k, l, xm(0), xm(2), xm(4));
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
// Each accepted command is answered with "# LED <number> <0|1>"
// (the web page ignores lines that start with #).
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
    }
  }
}

//----------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  analogReadResolution(10);
  for (int i = 0; i < N_Z; i++)
    R(i, i) = sigma2;
  hardware_alarm_claim(0);
  add_repeating_timer_us(-40, timer_callback, NULL, &timer);
}

void loop() {
  float corrSin[N_LED][N_PD] = {};
  float corrCos[N_LED][N_PD] = {};
  float RSS[N_LED][N_PD];
  float angle;
  unsigned long time1 = millis();

  readCommands();  // apply any LED on/off commands from the web page

  sampleIndex = 0;
  isSampling = true;
  while (isSampling) {
    // Do nothing, wait for all samples to be updated.
  }

  for (int f = 0; f < N_LED; f++) {
    if (!LED_ON[f]) continue;  // skip LEDs that are off (saves time; RSS stays 0)
    for (int i = 0; i < N; i++)
      for (int g = 0; g < N_PD; g++) {
        angle = 2.0f * M_PI * Fref[f] * i / samplingFreq;
        corrSin[f][g] += sampleTemp[g][i] * sin(angle);
        corrCos[f][g] += sampleTemp[g][i] * cos(angle);
      }
  }

  for (int f = 0; f < N_LED; f++)
    for (int g = 0; g < N_PD; g++) {
      RSS[f][g] = (1.0f)/N * sqrt(corrSin[f][g] * corrSin[f][g] + corrCos[f][g] * corrCos[f][g]); //
      zn(N_PD*f+g) = RSS[f][g];
      // Serial.print("RSS"); 
      if (mode == 1 || mode == 3){
        Serial.print(RSS[f][g]);
        Serial.print(", ");
      }
    }
  if (mode == 1 || mode == 3){  
    Serial.println("");
  }

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
      zHn(N_PD * f + g) = LED_ON[f] ? PtxGamma[f] * pathLossWithoutGamma(f, g, xHnnm1(0), xHnnm1(2), xHnnm1(4))
                                    : zn(N_PD * f + g);
  xHnm1nm1 = xHnnm1 + Kn * (zn - zHn);
  // Pnm1nm1 = (I6 - Kn*Jn) * Pnnm1; 
  Pnm1nm1 = (I6 - Kn*Jn) * Pnnm1 * ~(I6 - Kn*Jn) + Kn * R * ~Kn;
  xHnm1nm1(4) = boundAngle(xHnm1nm1(4)); 
  //Serial.print("Covariance"); Serial.println(Pnm1nm1);
  if (mode == 2 || mode == 3){
    // Web format:  Quadrant <n>: <x cm>, <y cm>, <angle deg>
    float xcm = xHnm1nm1(0) * 100.0;
    float ycm = xHnm1nm1(2) * 100.0;
    float deg = xHnm1nm1(4) / M_PI * 180.0;
    int q = (xcm >= 0) ? (ycm >= 0 ? 1 : 4) : (ycm >= 0 ? 2 : 3);
    Serial.print("Quadrant "); Serial.print(q); Serial.print(": ");
    Serial.print(xcm); Serial.print(", ");
    Serial.print(ycm); Serial.print(", ");
    Serial.println(deg);
  }
// 
  unsigned long time2 = millis();
  // Serial.println(time2-time1);
  // delayMicroseconds(200000);  //0.2s
}
