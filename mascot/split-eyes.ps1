# split eyes-eyebrows.png into 4 pieces (brow-l, brow-r, eye-l, eye-r)
Add-Type -AssemblyName System.Drawing
$dir = "C:\Users\SSAFY\AppData\Local\Temp\claude\C--Users-SSAFY-Desktop-TJmedia-clawad\12d0d8a5-32a5-415a-b028-1b0cca361b4e\scratchpad\parts"

$bmp = New-Object System.Drawing.Bitmap "$dir\eyes-eyebrows.png"
$w = $bmp.Width
$h = $bmp.Height
$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$conv = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($conv)
$g.DrawImage($bmp, 0, 0, $w, $h)
$g.Dispose()
$bmp.Dispose()
$data = $conv.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$bytes = New-Object byte[] ($data.Stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$conv.UnlockBits($data)
$stride = $data.Stride

$colOp = New-Object int[] $w
$rowOpL = New-Object int[] $h
$rowOpR = New-Object int[] $h
$half = [int]($w / 2)
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    if ($bytes[$y * $stride + $x * 4 + 3] -gt 10) {
      $colOp[$x] = $colOp[$x] + 1
      if ($x -lt $half) { $rowOpL[$y] = $rowOpL[$y] + 1 } else { $rowOpR[$y] = $rowOpR[$y] + 1 }
    }
  }
}

# vertical split: widest empty column band around center
$bandStart = -1
$bestMid = $half
$bestLen = 0
$x0 = [int]($w * 0.3)
$x1 = [int]($w * 0.7)
for ($x = $x0; $x -le $x1; $x++) {
  $empty = ($x -lt $w) -and ($colOp[$x] -eq 0)
  if ($empty) {
    if ($bandStart -lt 0) { $bandStart = $x }
  } else {
    if ($bandStart -ge 0) {
      $len = $x - $bandStart
      if ($len -gt $bestLen) {
        $bestLen = $len
        $bestMid = [int](($bandStart + $x - 1) / 2)
      }
      $bandStart = -1
    }
  }
}
Write-Output "vsplit x=$bestMid band=$bestLen"

# horizontal split per half: widest empty row band in y 5..h*0.6
function Find-HSplit {
  param($rowOp, $hh)
  $bs = -1
  $best = 40
  $bl = 0
  $yEnd = [int]($hh * 0.6)
  for ($y = 5; $y -le $yEnd; $y++) {
    $empty = ($rowOp[$y] -eq 0)
    if ($empty) {
      if ($bs -lt 0) { $bs = $y }
    } else {
      if ($bs -ge 0) {
        $len = $y - $bs
        if ($len -gt $bl) {
          $bl = $len
          $best = [int](($bs + $y - 1) / 2)
        }
        $bs = -1
      }
    }
  }
  return @($best, $bl)
}
$hl = Find-HSplit $rowOpL $h
$hr = Find-HSplit $rowOpR $h
Write-Output "hsplit-left y=$($hl[0]) band=$($hl[1])"
Write-Output "hsplit-right y=$($hr[0]) band=$($hr[1])"

function Save-Crop {
  param($rx0, $ry0, $rx1, $ry1, $name)
  $minX = $rx1; $maxX = $rx0; $minY = $ry1; $maxY = $ry0
  for ($y = $ry0; $y -lt $ry1; $y++) {
    for ($x = $rx0; $x -lt $rx1; $x++) {
      if ($bytes[$y * $stride + $x * 4 + 3] -gt 10) {
        if ($x -lt $minX) { $minX = $x }
        if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }
        if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $cw = $maxX - $minX + 1
  $ch = $maxY - $minY + 1
  $crop = New-Object System.Drawing.Bitmap $cw, $ch, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gg = [System.Drawing.Graphics]::FromImage($crop)
  $src = New-Object System.Drawing.Rectangle $minX, $minY, $cw, $ch
  $dstR = New-Object System.Drawing.Rectangle 0, 0, $cw, $ch
  $gg.DrawImage($conv, $dstR, $src, [System.Drawing.GraphicsUnit]::Pixel)
  $gg.Dispose()
  $crop.Save("$dir\$name.png")
  $crop.Dispose()
  Write-Output "$name offset=($minX,$minY) size=$cw x $ch"
}
Save-Crop 0 0 $bestMid $hl[0] "brow-l"
Save-Crop $bestMid 0 $w $hr[0] "brow-r"
Save-Crop 0 $hl[0] $bestMid $h "eye-l"
Save-Crop $bestMid $hr[0] $w $h "eye-r"
