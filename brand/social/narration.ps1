Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }
Write-Output ("voices: " + ($voices -join ", "))
$pick = $voices | Where-Object { $_ -match "Zira|Hazel|Susan|Aria|Jenny" } | Select-Object -First 1
if ($pick) { $s.SelectVoice($pick) }
$s.Rate = -1
$lines = Get-Content -Raw -Encoding UTF8 "$PSScriptRoot\narration.json" | ConvertFrom-Json
$i = 0
foreach ($l in $lines) {
  $path = "$PSScriptRoot\nar-$i.wav"
  $s.SetOutputToWaveFile($path)
  $s.Speak($l)
  $s.SetOutputToNull()
  Write-Output ("wrote nar-$i.wav")
  $i++
}
$s.Dispose()
