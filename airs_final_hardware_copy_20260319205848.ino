/*
  AIRS – Air Intelligent Response System
*/

#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <DHT.h>
#include <ESP32Servo.h>

/* DISPLAY */

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

/* SENSOR PINS */

#define MQ135_PIN 32
#define MQ2_PIN 34
#define MQ5_PIN 35
#define DHTPIN 4
#define FLAME_PIN 5

#define DHTTYPE DHT11
DHT dht(DHTPIN, DHTTYPE);

/* ACTUATORS */

#define SERVO_PIN 18
#define BUZZER_PIN 19

/* LEDS */

#define RED_LED 25
#define GREEN_LED 26
#define YELLOW_LED 27
#define BLUE_LED 33

Servo ventServo;

/* VARIABLES */

int mq135Value = 0;
int mq2Value = 0;
int mq5Value = 0;

int mq5Baseline = 0;

float temperature = 0;
float humidity = 0;

bool flameDetected = false;
bool simulationActive = false;

/* GAS THRESHOLDS */

#define MQ_WARNING 400
#define MQ_DANGER 800

/* POWER ESTIMATION */

float deviceVoltage = 5.0;
float deviceCurrent = 0.18;
float devicePower = deviceVoltage * deviceCurrent;

/* FUNCTIONS */

void initializeDisplay();
void showBootAnimation();
void readSensors();
void displaySensorValues();

void triggerDangerMode();
void triggerWarningMode();
void triggerSafeMode();

void handleSerialCommands();
void resetToMonitoringMode();

/* SETUP */

void setup() {

  Serial.begin(115200);

  pinMode(FLAME_PIN, INPUT);
  pinMode(BUZZER_PIN, OUTPUT);

  pinMode(RED_LED, OUTPUT);
  pinMode(GREEN_LED, OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(BLUE_LED, OUTPUT);

  digitalWrite(BLUE_LED, HIGH);

  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  ventServo.setPeriodHertz(50);
  ventServo.attach(SERVO_PIN, 500, 2400);
  ventServo.write(0);

  dht.begin();

  Wire.begin(21,22);

  initializeDisplay();
  showBootAnimation();

  int total = 0;

  for(int i=0;i<20;i++){
    total += analogRead(MQ5_PIN);
    delay(200);
  }

  mq5Baseline = total / 20;
}

/* LOOP */

void loop() {

  handleSerialCommands();

  if(!simulationActive){

    readSensors();
    displaySensorValues();

    int mq5Adjusted = mq5Value - mq5Baseline;

    if(flameDetected ||
       mq135Value > MQ_DANGER ||
       mq2Value > MQ_DANGER ||
       mq5Adjusted > 250){

        triggerDangerMode();
    }

    else if(mq135Value > MQ_WARNING ||
            mq2Value > MQ_WARNING ||
            mq5Adjusted > 120){

        triggerWarningMode();
    }

  }

  delay(1500);
}

/* DISPLAY INIT */

void initializeDisplay(){

  if(!display.begin(SSD1306_SWITCHCAPVCC,0x3C)){
    while(true);
  }

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
}

/* BOOT ANIMATION */

void showBootAnimation(){

  for(int i=0;i<=100;i+=4){

    display.clearDisplay();

    display.drawRect(0,0,128,64,WHITE);

    display.setTextSize(2);
    display.setCursor(28,10);
    display.println("AIRS");

    display.setTextSize(1);
    display.setCursor(25,35);
    display.println("Initializing");

    display.drawRect(14,50,100,8,WHITE);
    display.fillRect(16,52,i,4,WHITE);

    display.display();
    delay(40);
  }

  delay(500);
}

/* READ SENSORS */

void readSensors(){

  mq135Value = analogRead(MQ135_PIN);
  mq2Value = analogRead(MQ2_PIN);
  mq5Value = analogRead(MQ5_PIN);

  temperature = dht.readTemperature();
  humidity = dht.readHumidity();

  flameDetected = digitalRead(FLAME_PIN) == LOW;

  Serial.print("MQ135: ");
  Serial.print(mq135Value);

  Serial.print(" MQ2: ");
  Serial.print(mq2Value);

  Serial.print(" MQ5: ");
  Serial.print(mq5Value);

  Serial.print(" Temp: ");
  Serial.print(temperature);

  Serial.print("C Hum: ");
  Serial.print(humidity);

  Serial.print("% Flame: ");
  Serial.println(flameDetected ? "YES" : "NO");
}

/* OLED DASHBOARD */

void displaySensorValues(){

  display.clearDisplay();

  display.setTextSize(1);
  display.setCursor(40,0);
  display.print("AIRS SYSTEM");

  display.drawLine(0,10,128,10,WHITE);

  display.setCursor(0,14);
  display.print("MQ135");

  display.setCursor(45,14);
  display.print(mq135Value);

  display.drawRect(85,14,40,6,WHITE);
  display.fillRect(85,14,map(mq135Value,0,1000,0,40),6,WHITE);

  display.setCursor(0,24);
  display.print("MQ2");

  display.setCursor(45,24);
  display.print(mq2Value);

  display.drawRect(85,24,40,6,WHITE);
  display.fillRect(85,24,map(mq2Value,0,1000,0,40),6,WHITE);

  display.setCursor(0,34);
  display.print("MQ5");

  display.setCursor(45,34);
  display.print(mq5Value);

  display.drawRect(85,34,40,6,WHITE);
  display.fillRect(85,34,map(mq5Value,0,1000,0,40),6,WHITE);

  display.drawLine(0,44,128,44,WHITE);

  display.setCursor(0,48);
  display.print("T:");
  display.print(temperature,1);
  display.print("C");

  display.setCursor(50,48);
  display.print("H:");
  display.print(humidity,0);
  display.print("%");

  display.setCursor(0,56);
  display.print("I:");
  display.print(deviceCurrent,2);

  display.setCursor(65,56);
  display.print("P:");
  display.print(devicePower,2);

  display.display();
}

/* DANGER MODE */

void triggerDangerMode(){

  simulationActive = true;

  digitalWrite(RED_LED,HIGH);
  digitalWrite(GREEN_LED,LOW);
  digitalWrite(YELLOW_LED,LOW);

  digitalWrite(BUZZER_PIN,HIGH);

  ventServo.write(90);

  display.clearDisplay();

  display.drawRect(0,0,128,64,WHITE);

  display.setTextSize(2);
  display.setCursor(20,12);
  display.println("DANGER");

  display.setTextSize(1);
  display.setCursor(18,38);
  display.println("Gas / Flame Detected");

  display.display();

  delay(2000);

  digitalWrite(BUZZER_PIN,LOW);

  resetToMonitoringMode();
}

/* WARNING MODE */

void triggerWarningMode(){

  simulationActive = true;

  digitalWrite(YELLOW_LED,HIGH);
  digitalWrite(RED_LED,LOW);
  digitalWrite(GREEN_LED,LOW);

  ventServo.write(40);

  display.clearDisplay();

  display.drawRect(0,0,128,64,WHITE);

  display.setTextSize(2);
  display.setCursor(15,10);
  display.println("WARNING");

  display.setTextSize(1);
  display.setCursor(20,38);
  display.println("Gas Level Rising");

  display.display();

  delay(3000);

  resetToMonitoringMode();
}

/* SAFE MODE */

void triggerSafeMode(){

  simulationActive = true;

  digitalWrite(GREEN_LED,HIGH);
  digitalWrite(RED_LED,LOW);
  digitalWrite(YELLOW_LED,LOW);

  ventServo.write(0);

  display.clearDisplay();

  display.drawRect(0,0,128,64,WHITE);

  display.setTextSize(2);
  display.setCursor(28,15);
  display.println("SAFE");

  display.setTextSize(1);
  display.setCursor(18,40);
  display.println("Environment Normal");

  display.display();

  delay(3000);

  resetToMonitoringMode();
}

/* SERIAL COMMANDS */

void handleSerialCommands(){

  if(Serial.available()){

    String command = Serial.readStringUntil('\n');
    command.trim();

    if(command=="danger"){
      triggerDangerMode();
    }
    else if(command=="mild"){
      triggerWarningMode();
    }
    else if(command=="safe"){
      triggerSafeMode();
    }
  }
}

/* RESET */

void resetToMonitoringMode(){

  digitalWrite(RED_LED,LOW);
  digitalWrite(YELLOW_LED,LOW);
  digitalWrite(GREEN_LED,LOW);

  digitalWrite(BLUE_LED,HIGH);

  simulationActive=false;

  display.clearDisplay();
  display.display();

  delay(500);
}