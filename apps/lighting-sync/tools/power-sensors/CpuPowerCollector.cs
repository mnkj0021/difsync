using System;
using System.Globalization;
using System.IO;
using System.Threading;
using LibreHardwareMonitor.Hardware;

internal sealed class CpuPowerCollector {
  private static readonly string OutputPath = @"G:\DifSync\tools\power-sensors\cpu-telemetry.json";
  private static readonly CultureInfo C = CultureInfo.InvariantCulture;
  private static string Number(float? value) {
    return value.HasValue ? value.Value.ToString("0.###", C) : "null";
  }
  private static float? ValidPower(float? value) {
    return value.HasValue && value.Value > 0.2f && value.Value < 450f && !float.IsNaN(value.Value) ? value : null;
  }
  private static void Write(float? power, float? temp, string status) {
    string result="{\"cpu_package_w\":"+Number(power)+",\"cpu_temp_c\":"+Number(temp)+
      ",\"sampled_at_unix\":"+DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(C)+
      ",\"source\":\"LibreHardwareMonitor Intel RAPL\",\"status\":\""+status+"\"}";
    string temporary=OutputPath+".tmp";
    File.WriteAllText(temporary,result);
    if(File.Exists(OutputPath))File.Replace(temporary,OutputPath,null);
    else File.Move(temporary,OutputPath);
  }
  public static int Main() {
    bool owner;
    using(Mutex mutex=new Mutex(true, @"Local\DifSyncCpuPowerCollector",out owner)){
      if(!owner) return 0;
      try{
        Computer computer=new Computer();
        computer.IsCpuEnabled=true;
        computer.Open();
        int misses=0;
        while(true){
          float? power=null, temp=null;
          foreach(IHardware hw in computer.Hardware){
            if(hw.HardwareType != HardwareType.Cpu)continue;
            hw.Update();
            foreach(ISensor sensor in hw.Sensors){
              if(sensor.SensorType==SensorType.Power && sensor.Name=="CPU Package")power=ValidPower(sensor.Value);
              if(sensor.SensorType==SensorType.Temperature && sensor.Name=="CPU Package")temp=sensor.Value;
            }
          }
          string status=power.HasValue ? "measured" : "unavailable";
          Write(power,temp,status);
          if(power.HasValue) misses=0;
          else misses++;
          if(misses>=4){
            Console.Error.WriteLine("CPU RAPL counters unavailable. Run sensor collector elevated and check driver support.");
            computer.Close();return 2;
          }
          Thread.Sleep(2000);
        }
      }catch(Exception e){
        try{Write(null,null,"error");}catch{}
        Console.Error.WriteLine(e.GetType().Name+": "+e.Message);
        return 1;
      }
    }
  }
}