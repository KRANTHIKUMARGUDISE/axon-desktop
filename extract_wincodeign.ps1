$7za = "D:\AXON\axon-desktop\node_modules\7zip-bin\win\x64\7za.exe"
$cacheDir = "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign"
$archive = Get-Item "$cacheDir\*.7z" -ErrorAction SilentlyContinue | Select-Object -First 1

if ($archive) {
    $extractDir = "$cacheDir\extracted_temp"
    Write-Host "Extracting archive without darwin folder..."
    
    # Extract all files
    & $7za x "$($archive.FullName)" "-o$extractDir" -y 2>&1 | grep -v "ERROR: Cannot create"
    
    # Remove darwin folder which has symlinks
    if (Test-Path "$extractDir\darwin") {
        Remove-Item "$extractDir\darwin" -Recurse -Force
        Write-Host "Removed darwin folder"
    }
    
    # Move to proper location
    $archiveBaseName = [System.IO.Path]::GetFileNameWithoutExtension($archive.Name)
    $destDir = "$cacheDir\$archiveBaseName"
    
    if (Test-Path $destDir) {
        Remove-Item $destDir -Recurse -Force
    }
    
    Move-Item $extractDir $destDir -Force
    Write-Host "Extraction complete at $destDir"
}
