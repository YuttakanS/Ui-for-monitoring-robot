# robot.ino เทียบกับ firmware ของอาจารย์ (m2v3) / robot.ino compared with the professor's firmware (m2v3)

2026-11-25 · branch `feature/task-2-led-spacing`

- ไฟล์ของอาจารย์ / Professor's file: `reading_rss_PD_pyramid_vOK_LEDcenter_P_Q_ch_big_size_m2v3.ino` (ไม่อยู่ใน repo และไม่ได้แก้ / not in the repo, not modified)
- ไฟล์ของเรา / Ours: `firmware/robot/robot.ino`

[ภาษาไทย](#ภาษาไทย) · [English](#english)

---

## ภาษาไทย

เอกสารนี้นับไฟล์ของอาจารย์เป็นจุดเริ่ม แล้วสรุปว่า `robot.ino` ปัจจุบันต่างไปอย่างไร และแต่ละการแก้ให้ผลอย่างไร จริง ๆ แล้ว `robot.ino` พัฒนามาจาก firmware รุ่นก่อนของอาจารย์ตั้งแต่ 17 พ.ย. ส่วนแนวคิดเลือก LED จากไฟล์ m2v3 นำเข้ามาเมื่อ 25 พ.ย. ตารางด้านล่างจึงเป็นการเทียบผลลัพธ์ของสองไฟล์ ไม่ใช่ประวัติการแก้

**ที่มาของตัวเลขผลลัพธ์**
- **บอร์ด** = วัดบนบอร์ดจริง
- **PC** = คำนวณจากข้อมูลจริงที่วัดไว้
- **จำลอง** = EKF จำลองบน PC ด้วยข้อมูลสังเคราะห์
- **leave-one-out** = calibrate จากทุกจุดยกเว้นหนึ่งจุด แล้วคำนวณตำแหน่งของจุดที่เหลือ
- ถ้าไม่ได้ระบุอย่างอื่น ใช้ข้อมูล `data/2026-11-25/calib_105643.csv` (12 จุด, หุ่นนิ่ง, θ = 0°)

### 1. แก้บั๊ก

ผลบน PC: ใช้แบบจำลองและ gamma ปัจจุบัน เลือก LED แบบ quadrant ของอาจารย์ แล้วใส่บั๊กเข้าไปทีละข้อ (ใช้ทุกจุดคำนวณ ไม่ใช่ leave-one-out) เมื่อแก้ครบทุกข้อ ความคลาดของ x/y เฉลี่ย 4.5 cm สูงสุด 11.1 cm

| ไฟล์อาจารย์ | `robot.ino` | ผลลัพธ์ (PC) |
|---|---|---|
| Q3 ใช้ RSS ของ LED 6 แทน LED 5 (`flatvalues` ไปหยิบ `RSS[6]` แต่ `p` เป็นตำแหน่งของ LED 5) | ไม่มี quadrant แล้ว ทุก LED ใช้ RSS ของตัวเองตามแถว | ถ้ามีบั๊กนี้: จุดที่อยู่ใน Q3 คลาดเฉลี่ย **57 cm** (สูงสุด 86 cm) ภาพรวมเฉลี่ย 13.3 cm → แก้แล้ว 4.5 cm |
| `PtxGamma[k]` ใช้ลำดับใน quadrant (0–3) ทุก quadrant จึงได้ gamma ของ LED 0–3 | gamma ตรงกับ LED จริงตามแถวของ `p` (มี `LED_NUM` บอกเลข LED) | ถ้ามีบั๊กนี้: เฉลี่ย **7.1 cm** สูงสุด 23.7 cm → แก้แล้ว 4.5 cm |
| γ ถูกคูณสองครั้ง แบบจำลองจริงจึงเป็น γ² | คูณครั้งเดียว | ถ้ามีบั๊กนี้ (กับ gamma ที่ calibrate แบบคูณครั้งเดียว): เฉลี่ย **9.5 cm** สูงสุด 16.7 cm → แก้แล้ว 4.5 cm ถ้า gamma ของอาจารย์ calibrate มากับโค้ดที่คูณสองครั้ง ผลจะน้อยกว่านี้ |
| `float values[i][j] = {};` ใช้ `i`, `j` ที่ยังไม่ได้กำหนดค่าเป็นขนาด array (UB) | เอาออก ใส่ค่าลง `zn` ตรง ๆ | วัดเป็นตัวเลขไม่ได้ อาจเขียนทับหน่วยความจำ ผลจึงคาดเดาไม่ได้ |

### 2. แบบจำลองแสง

| | ไฟล์อาจารย์ | `robot.ino` | ผลลัพธ์ |
|---|---|---|---|
| มุม normal ของ PD (`be`) | 60° | **55°** (หน้าพีระมิดวัดได้เอียง 35° จากพื้น) | PC (leave-one-out, 4 LED, 19 พ.ย.): 6.7 → **5.9 cm** · บอร์ด (ดูด้วยตา): ราว 3 cm → **1–2 cm** |
| ความไวของแต่ละ PD | ถือว่าเท่ากัน | เพิ่ม **`PD_GAIN`** = 1, 0.759, 0.926 | ใช้คู่กับ `RSS_OFFSET` (แถวถัดไป) |
| ค่าคงที่ (แสงสะท้อน, noise floor) | ไม่มี | เพิ่ม **`RSS_OFFSET`** = 0.0461 | รวมสองแถว (PC, 4 LED, 19 พ.ย.): แบบจำลองคลาดจากค่าที่วัดได้ 12–18% → **8–10%** · x/y (leave-one-out) 5.9 → **3.6 cm** · ทำให้ประมาณ z ได้ · ยังไม่ได้วัดบนบอร์ด |
| `PtxGamma` | 0.55, 0.48, 0.51, … (calibrate ตอนใช้ 4 ดวง) | **calibrate ใหม่ครบ 9 ดวง** (25 พ.ย.) | PC (leave-one-out): x/y **4.1 cm** · แบบจำลองคลาด 15–24% ต่อ LED (มากกว่าตอนใช้ 4 ดวง) · ยังไม่ได้ยืนยันบนบอร์ด (การทดสอบบนบอร์ดครั้งแรกเจอปัญหา PD2 ก่อน ดูข้อ 4) |
| ลำดับ LED ในตาราง | 0 → 8 | 4, 5, 7, 8, 1, 2, 0, 3, 6 (`Fref` และ `p` เรียงตามนี้) | เป็นแค่การจัดลำดับ ไม่มีผลต่อตำแหน่ง |

### 3. การเลือก LED ที่ EKF ใช้

| | ไฟล์อาจารย์ | `robot.ino` | ผลลัพธ์ (PC, leave-one-out) |
|---|---|---|---|
| วิธีเลือก | quadrant 2×2 ที่แสงรวมมากที่สุด ใช้ 4 ดวง (แก้บั๊กแล้ว) | **LED ที่แรงที่สุด 6 ดวง** (`LED_USE_K`) จากทุกดวงที่เปิดอยู่ | quadrant: เฉลี่ย 6.32 cm สูงสุด 20.4 cm · **6 ดวง: เฉลี่ย 3.72 cm สูงสุด 10.5 cm** · 9 ดวง: เฉลี่ย 4.13 cm สูงสุด 11.5 cm |
| เปลี่ยนจำนวนดวง | – | คำสั่ง `USE <k>` | เทียบ 6 กับ 9 ดวงบนบอร์ดได้โดยไม่ต้อง upload ใหม่ |
| เปิด/ปิด LED แต่ละดวง | – | คำสั่ง `LED <n> <0\|1>` | ตัด LED ที่ไม่ติดจริงออกได้ (ถ้า EKF ใช้ LED ที่ไม่ติด จะเห็นค่า 0 แล้วดึงตำแหน่งให้เพี้ยน) |

แบบ quadrant ทำได้ดีเมื่อหุ่นอยู่กลางเซลล์ (1.6–1.9 cm เทียบกับ 2.6–3.2 cm เมื่อใช้ 9 ดวง) แต่ที่ขอบและมุมกรอบ LED ทั้ง 4 ดวงอยู่ด้านเดียวของหุ่น ความคลาดจึงขึ้นไปถึง 12–20 cm เช่นที่ (0, 50) และ (50, 50) ข้อมูลมีแค่ 12 จุด จึงยังต้องเทียบ `USE 6` กับ `USE 9` บนบอร์ด

### 4. EKF

| | ไฟล์อาจารย์ | `robot.ino` | ผลลัพธ์ |
|---|---|---|---|
| State | 6 (x, y, θ และความเร็ว) | **8** (เพิ่ม z, vz) จำกัด z ไว้ที่ 0–80 cm | PC: z บนพื้น rms 2.3 cm (4 LED) และราว 3 cm (9 LED) x/y ไม่แย่ลง · บอร์ด (25 พ.ย.): z ติดที่ 0 เมื่อแสงที่วัดได้อ่อนกว่าแบบจำลอง |
| Q ของตำแหน่ง | 1e-6 | **1e-4** ปรับตามเวลารอบ (`Q0·T/T_REF`) | บอร์ด (move_straight 19 พ.ย.): วิ่งเลย 7 → **5 cm** (ทั้งที่รอบใหม่ขยับหุ่นเร็วกว่า 3 เท่า) · นิ่งภายใน 2 cm จาก ~11 s → **~5 s** · แลกกับการสั่นตอนนิ่งที่เพิ่มจาก 0.1 เป็น 0.6–0.8 cm |
| `T` | 0.2 s คงที่ | **วัดเวลารอบจริง** (~0.05 s) | ความเร็วที่ EKF ประมาณถูกต้องตามเวลาจริง (วัดผลรวมกับแถว Q) |
| `sigma2` | 0.1 | 0.01 (ไม่เปลี่ยน) | จำลอง (หุ่นวิ่ง 50 cm ใน 2 s): ถ้าใช้ 0.1 การสั่นลด 0.39 → 0.28 cm แต่ตามหลังเพิ่ม 4.0 → 9.1 cm วิ่งเลยเพิ่ม 4.7 → 8.1 cm นิ่งช้าลง 2.0 → 4.4 s |
| การอัปเดต | inverse เมทริกซ์ 12×12 | **อัปเดตทีละค่า** (`EKF_SEQUENTIAL`) | test ยืนยันว่าได้ state และ covariance เท่าเดิม · เร็วขึ้น (เป็นส่วนหนึ่งของ 330 → 119 ms ในข้อ 5) |
| PD ที่อ่านต่ำผิดปกติ | ไม่มีการตรวจ | **`SKIP_LOW_PD`** ข้าม PD ที่อ่านได้ต่ำกว่า 0.40 เท่าของค่ากลาง (ตรวจจากทุกดวงที่เปิด) | PC: ที่ (−25, −25) (PD2 อ่านได้ ~1/4) คลาด >30 cm → **<6 cm** · ที่ (0, 0) ตอน 13:41 (PD2 ~1/3) คลาด 18 cm → **2.1 cm** · ยังไม่ได้วัดบนบอร์ด |

### 5. ความเร็ว

| | ไฟล์อาจารย์ | `robot.ino` | ผลลัพธ์ (บอร์ด) |
|---|---|---|---|
| Demodulate | เรียก `sin()`/`cos()` ราว 135,000 ครั้งต่อรอบ | **ตาราง sin/cos + จำนวนเต็ม** (ความถี่ LED ต้องเป็นพหุคูณของ 100 Hz) | รวมกับสองแถวถัดไป (19 พ.ย.): รอบละ ~330 ms (3 Hz) → **119.2 ms (8.4 Hz)** แบ่งเป็น เก็บสัญญาณ 100.0 · demod 12.0 · EKF 6.9 ms |
| ฟังก์ชัน path loss | ใช้เมทริกซ์ BLA และ `pow()` | คำนวณ float ตรง ๆ และคำนวณ sin/cos ของมุมครั้งเดียวต่อรอบ | (รวมในแถวบน) |
| อัปเดต EKF ทีละค่า | – | ดูข้อ 4 | (รวมในแถวบน) |
| การเก็บสัญญาณ | เก็บ 2500 ตัวอย่าง รอจนเต็ม แล้วค่อยคำนวณ | **เก็บต่อเนื่องใน ring buffer** ใช้ window ที่ซ้อนกัน 50% | 8.4 → **20.0 Hz** (`wait=20.1 demod=19.0 ekf=10.2 total=50.0` ms) noise ต่อค่าเท่าเดิม |
| ตัวนับ sample ล้นหลัง 47.7 ชั่วโมง | ไม่มีตัวนับต่อเนื่อง | แก้แล้ว | test จำลองข้ามจุดล้นผ่าน · ถ้าไม่แก้ บอร์ดจะค้างหลังเปิดต่อเนื่อง 47.7 ชั่วโมง · ยังไม่ได้วัดบนบอร์ด |

### 6. การรับส่งข้อมูล

| | ไฟล์อาจารย์ | `robot.ino` | ผลลัพธ์ |
|---|---|---|---|
| บรรทัดตำแหน่ง | `Quadrant n: x, y, deg` | `Quadrant n: x, y, deg, z` | หน้าเว็บแสดงแท่งความสูง และ CSV มีคอลัมน์ z |
| RSS (mode 1/3) | ทศนิยม 2 ตำแหน่ง | **4 ตำแหน่ง** | ค่าที่อ่อนที่สุดใน calibrate อยู่ราว 0.03 ถ้าใช้ 2 ตำแหน่งจะปัดคลาดได้ถึง ±17% |
| คำสั่ง serial | ไม่มี (`mode` แก้ได้ในโค้ดเท่านั้น) | `LED`, `USE`, `MODE`, `TIMING`, `WIFI` | calibrate ได้โดยไม่ต้อง upload ใหม่ (หน้า calibrate ส่ง `MODE 3` เอง) · วัดเวลาแต่ละส่วนของรอบบนบอร์ดได้ (`TIMING 1`) |
| WiFi | ไม่มี | **Pico W ปล่อย WiFi เอง** (`RA-Robot`, `192.168.42.1`) | บอร์ด (20 พ.ย.): ใช้งานได้ เปิดทั้งสองหน้าพร้อมกันได้ · ยังไม่ได้วัด noise ของ ADC และเวลารอบตอนเปิด WiFi |
| ข้อความวินิจฉัย | – | `# T`, `# PD n low, skipped` | เห็นได้ทันทีว่ารอบช้าลงตรงไหน หรือ PD ตัวไหนถูกข้าม |

### ที่ยังเหมือนกัน

ตำแหน่ง LED (x ±50, y ±51.5, สูง 92 cm), ความถี่ LED ทุกดวง, `N` = 2500, sampling 25 kHz, ขา PD (GP28/27/26), `m` = 1, FoV = 90°, `al`, `eps`, P0, Q ของมุม และการคำนวณ P แบบ Joseph form

### สถานะการทดสอบบนบอร์ด

- **วัดแล้ว:** 20 Hz, WiFi, ค่า Q/T ใหม่, `be` = 55° (ตอนใช้ 4 ดวง)
- **ยังไม่ได้วัด:** ทุกอย่างที่ทำเมื่อ 25 พ.ย. ได้แก่ ค่า calibrate 9 ดวง, `LED_USE_K`, `MODE`, การแก้ตัวนับล้น และเกณฑ์ `lowPd` ใหม่
- **ทดสอบบนบอร์ดครั้งแรก (25 พ.ย. 13:02, `USE 6`, หุ่นที่ (0, 0)):** ตำแหน่งคลาด 13 cm สาเหตุคือ PD2 (GP26) อ่านได้ราว 1/3 ของค่าปกติกับทุก LED ซึ่งน่าจะเป็นสายหรือขั้วต่อหลวม และ `lowPd()` ตอนนั้นไม่ข้าม PD2 เพราะตรวจจากแค่ 6 ดวง หลังแก้ คำนวณจาก RSS ชุดเดียวกันบน PC ได้คลาดราว 2 cm

---

## English

This document takes the professor's file as the starting point and lists how the current `robot.ino` differs from it and what each change did. In fact, `robot.ino` grew out of the professor's earlier firmware from 17 Nov; only the idea of choosing LEDs came from the m2v3 file, on 25 Nov. The tables therefore compare the two files, not a history of edits.

**Where the result numbers come from**
- **Board** = measured on the real board.
- **PC** = computed from real measured data.
- **Simulation** = EKF replica on the PC with synthetic data.
- **Leave one out** = calibrate on all poses but one, then estimate the position at the pose left out.
- Unless stated otherwise, the data is `data/2026-11-25/calib_105643.csv` (12 poses, robot still, θ = 0°).

### 1. Bug fixes

Results on the PC: the current model and gammas, LEDs chosen by the professor's quadrant rule, with one bug put back at a time (all poses used, not leave one out). With every bug fixed, the x / y error is 4.5 cm on average and 11.1 cm at most.

| Professor's file | `robot.ino` | Result (PC) |
|---|---|---|
| Quadrant 3 takes the RSS of LED 6 for LED 5 (`flatvalues` uses `RSS[6]`, while `p` holds the position of LED 5) | No quadrants; every LED uses its own RSS, by row | With this bug: poses in Q3 are **57 cm** off on average (86 cm at most); overall mean 13.3 cm → 4.5 cm fixed |
| `PtxGamma[k]` is indexed by the position within the quadrant (0–3), so every quadrant uses the gammas of LEDs 0–3 | The gamma matches the real LED, by the row of `p` (`LED_NUM` gives the LED number) | With this bug: mean **7.1 cm**, max 23.7 cm → 4.5 cm fixed |
| γ is applied twice, so the model is really γ² | Applied once | With this bug (and gammas calibrated for a single γ): mean **9.5 cm**, max 16.7 cm → 4.5 cm fixed. If the professor's gammas were calibrated with the doubled code, the effect is smaller |
| `float values[i][j] = {};` sizes the array with `i`, `j` before they are set (undefined behaviour) | Removed; the values go straight into `zn` | Cannot be measured as a number: it may overwrite other memory, so the effect is unpredictable |

### 2. Light model

| | Professor's file | `robot.ino` | Result |
|---|---|---|---|
| Photodiode normal elevation (`be`) | 60° | **55°** (the pyramid faces measure 35° from the floor) | PC (leave one out, 4 LEDs, 19 Nov): 6.7 → **5.9 cm** · Board (by eye): about 3 cm → **1–2 cm** |
| Photodiode sensitivity | Assumed equal | **`PD_GAIN`** = 1, 0.759, 0.926 | Used together with `RSS_OFFSET` (next row) |
| Constant term (reflections, noise floor) | None | **` `** = 0.0461 | Both rows together (PC, 4 LEDs, 19 Nov): model misfit 12–18 % → **8–10 %** · x / y (leave one out) 5.9 → **3.6 cm** · makes z estimation possible · not measured on the board |
| `PtxGamma` | 0.55, 0.48, 0.51, … (calibrated with 4 LEDs) | **Recalibrated with all 9 LEDs** (25 Nov) | PC (leave one out): x / y **4.1 cm** · model misfit 15–24 % per LED (more than with 4 LEDs) · not confirmed on the board (the first board test hit the PD 2 problem first, see section 4) |
| LED order in the tables | 0 → 8 | 4, 5, 7, 8, 1, 2, 0, 3, 6 (`Fref` and `p` follow this order) | Bookkeeping only; no effect on the position |

### 3. Which LEDs the EKF uses

| | Professor's file | `robot.ino` | Result (PC, leave one out) |
|---|---|---|---|
| Choice | The 2 × 2 quadrant with the most light, 4 LEDs (bugs fixed) | **The 6 brightest LEDs** (`LED_USE_K`) out of all lit LEDs | Quadrant: mean 6.32 cm, max 20.4 cm · **6 LEDs: mean 3.72 cm, max 10.5 cm** · 9 LEDs: mean 4.13 cm, max 11.5 cm |
| Number of LEDs | – | Command `USE <k>` | 6 and 9 LEDs can be compared on the board without a new upload |
| Each LED on / off | – | Command `LED <n> <0\|1>` | An LED that is not lit can be left out (an unlit LED in the EKF reads 0 and pulls the position away) |

The quadrant method does well in the middle of a cell (1.6–1.9 cm, against 2.6–3.2 cm with 9 LEDs), but at the edges and corners of the frame all 4 LEDs are on one side of the robot, and the error reaches 12–20 cm, for example at (0, 50) and (50, 50). With only 12 poses, `USE 6` and `USE 9` still have to be compared on the board.

### 4. EKF

| | Professor's file | `robot.ino` | Result |
|---|---|---|---|
| State | 6 (x, y, θ and their rates) | **8** (adds z, vz); z is kept within 0–80 cm | PC: z on the floor rms 2.3 cm (4 LEDs) and about 3 cm (9 LEDs); x / y no worse · Board (25 Nov): z stuck at 0 when the measured light was weaker than the model |
| Position Q | 1e-6 | **1e-4**, scaled with the loop time (`Q0·T/T_REF`) | Board (move_straight, 19 Nov): overshoot 7 → **5 cm** (with a move 3 times faster) · within 2 cm after ~11 s → **~5 s** · at the cost of more jitter when still, 0.1 → 0.6–0.8 cm |
| `T` | 0.2 s, fixed | **Measured loop time** (~0.05 s) | The EKF's velocity follows real time (measured together with the Q row) |
| `sigma2` | 0.1 | 0.01 (kept) | Simulation (robot moving 50 cm in 2 s): with 0.1, jitter 0.39 → 0.28 cm, but lag 4.0 → 9.1 cm, overshoot 4.7 → 8.1 cm, settling 2.0 → 4.4 s |
| Update | 12 × 12 matrix inverse | **One measurement at a time** (`EKF_SEQUENTIAL`) | Tests confirm the same state and covariance · faster (part of 330 → 119 ms in section 5) |
| Photodiode reading far too low | Not checked | **`SKIP_LOW_PD`** leaves out a photodiode below 0.40 of the median share (judged on every lit LED) | PC: at (−25, −25) (PD 2 at ~1/4) more than 30 cm off → **under 6 cm** · at (0, 0) at 13:41 (PD 2 at ~1/3) 18 cm → **2.1 cm** · not measured on the board |

### 5. Speed

| | Professor's file | `robot.ino` | Result (board) |
|---|---|---|---|
| Demodulation | About 135,000 calls to `sin()` / `cos()` per loop | **sin / cos table + integer arithmetic** (LED frequencies must be multiples of 100 Hz) | With the next two rows (19 Nov): ~330 ms per loop (3 Hz) → **119.2 ms (8.4 Hz)**: sampling 100.0 · demod 12.0 · EKF 6.9 ms |
| Path-loss function | BLA matrices and `pow()` | Plain float arithmetic; the heading's sin / cos computed once per loop | (included above) |
| EKF one value at a time | – | See section 4 | (included above) |
| Sampling | Fills 2500 samples, waits, then computes | **Continuous ring buffer**, windows overlapping by 50 % | 8.4 → **20.0 Hz** (`wait=20.1 demod=19.0 ekf=10.2 total=50.0` ms); same noise per value |
| Sample counter wrap after 47.7 h | No running counter | Fixed | A test replica across the wrap passes · without the fix the board would hang after 47.7 h of continuous running · not measured on the board |

### 6. Input and output

| | Professor's file | `robot.ino` | Result |
|---|---|---|---|
| Position line | `Quadrant n: x, y, deg` | `Quadrant n: x, y, deg, z` | The web page shows a height bar and the CSV has a z column |
| RSS (mode 1 / 3) | 2 decimals | **4 decimals** | The weakest calibration values are about 0.03; 2 decimals would round them by up to ±17 % |
| Serial commands | None (`mode` set in the code only) | `LED`, `USE`, `MODE`, `TIMING`, `WIFI` | Calibration without a new upload (the calibrate page sends `MODE 3`) · loop timing readable on the board (`TIMING 1`) |
| WiFi | None | **The Pico W runs its own network** (`RA-Robot`, `192.168.42.1`) | Board (20 Nov): works; both pages can be open at once · ADC noise and loop time with WiFi on not measured yet |
| Diagnostic lines | – | `# T`, `# PD n low, skipped` | Shows at once which part of the loop is slow or which photodiode is left out |

### Unchanged

LED positions (x ±50, y ±51.5, 92 cm high), every LED frequency, `N` = 2500, 25 kHz sampling, photodiode pins (GP28 / 27 / 26), `m` = 1, FoV = 90°, `al`, `eps`, P0, the heading Q and the Joseph-form covariance update.

### Board test status

- **Measured:** 20 Hz, WiFi, the new Q / T, `be` = 55° (with 4 LEDs).
- **Not measured yet:** everything done on 25 Nov: the 9-LED calibration, `LED_USE_K`, `MODE`, the counter wrap fix and the new `lowPd` limit.
- **First board test (25 Nov 13:02, `USE 6`, robot at (0, 0)):** the position was 13 cm off. PD 2 (GP26) read about 1/3 of normal for every LED, most likely a loose wire or connector, and `lowPd()` at the time did not leave PD 2 out because it judged on only 6 LEDs. After the fix, the same RSS gives about 2 cm on the PC.
