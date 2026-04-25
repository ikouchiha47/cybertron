// Minimal hardware test — no BLE, no IMU, just LED blink.
// If this blinks, hardware is fine and the main firmware is crashing on boot.
// If this doesn't blink, the nRF52840 itself has a problem.

void setup() {
  pinMode(LED_BLUE, OUTPUT);
  pinMode(LED_RED,  OUTPUT);
  // 10 rapid blinks on startup
  for (int i = 0; i < 10; i++) {
    digitalWrite(LED_BLUE, HIGH);
    delay(100);
    digitalWrite(LED_BLUE, LOW);
    delay(100);
  }
}

void loop() {
  digitalWrite(LED_BLUE, HIGH); delay(500);
  digitalWrite(LED_BLUE, LOW);  delay(500);
}
