const byte ENA=5,ENB=6,IN1=7,IN2=8,IN3=11,IN4=12,TRIG=9,ECHO=10;
void drive(int l,int r){
 digitalWrite(IN1,l>0); digitalWrite(IN2,l<0);
 digitalWrite(IN3,r>0); digitalWrite(IN4,r<0);
 analogWrite(ENA,abs(l)); analogWrite(ENB,abs(r));
}
void brake(){digitalWrite(IN1,LOW);digitalWrite(IN2,LOW);digitalWrite(IN3,LOW);digitalWrite(IN4,LOW);analogWrite(ENA,255);analogWrite(ENB,255);}
void setup(){
 Serial.begin(115200);
 byte pins[]={ENA,ENB,IN1,IN2,IN3,IN4,TRIG};
 for(byte i=0;i<7;i++) pinMode(pins[i],OUTPUT);
 pinMode(ECHO,INPUT); brake(); Serial.println("READY threshold_cm=20");
}
void loop(){
 digitalWrite(TRIG,LOW);delayMicroseconds(2);digitalWrite(TRIG,HIGH);delayMicroseconds(10);digitalWrite(TRIG,LOW);
 unsigned long echo=pulseIn(ECHO,HIGH,30000UL);
 float cm=echo/58.0; Serial.print("distance_cm=");Serial.println(cm);
 if(!echo){brake();Serial.println("STOP no_echo");}
 else if(cm<20){
 brake();delay(180);Serial.println("TURN_RIGHT");drive(100,-100);delay(330);brake();delay(180);
 }else{drive(100,100);Serial.println("FORWARD");}
 delay(65);
}