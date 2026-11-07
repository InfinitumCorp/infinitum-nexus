#!/usr/bin/env bash
# Unsigned per-machine MSI. No Authenticode certificate is purchased or used.
# wixl writes a random summary revision and the current time. normalize-msi.py
# replaces both from SOURCE_DATE_EPOCH and a fixed package code.
set -euo pipefail
src="${1:?windows directory}"
out="${2:?msi path}"
root="$(cd "$(dirname "$0")/.." && pwd)"
if ! command -v wixl >/dev/null 2>&1; then
  echo "wixl is not installed; unsigned MSI was not produced" >&2
  exit 0
fi
if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
  echo "SOURCE_DATE_EPOCH is required to build the MSI" >&2
  exit 1
fi
package_code="7A1C5E34-2B90-4F68-8D12-9C0E3A6B5D47"
product_code="4F8E2A91-6C3D-4B70-9A15-2D7E6B0C8F21"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$src/veil-desktop.exe" "$src/wintun.dll" "$src/WINTUN-LICENSE.txt" "$work/"
touch -d "@${SOURCE_DATE_EPOCH}" "$work/veil-desktop.exe" "$work/wintun.dll" "$work/WINTUN-LICENSE.txt"
cat > "$work/veil.wxs" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="${product_code}" Name="VEIL Desktop" Language="1033" Version="0.9.0"
           Manufacturer="Infinitum Corporation" UpgradeCode="8D6A1B2E-4C70-4E1A-9B5A-6E0A7C1D4F10">
    <Package Id="${package_code}" InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Description="Infinitum Corporation VEIL Desktop" />
    <MediaTemplate EmbedCab="yes" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="VEIL Desktop">
          <Component Id="MainExecutable" Guid="C1A0B5E2-7D44-4A11-9E20-11A0B5E27D44">
            <File Id="VeilExe" Source="veil-desktop.exe" KeyPath="yes" />
          </Component>
          <Component Id="WinTunDll" Guid="C1A0B5E2-7D44-4A11-9E20-22A0B5E27D44">
            <File Id="WinTunFile" Source="wintun.dll" KeyPath="yes" />
          </Component>
          <Component Id="WinTunLicense" Guid="C1A0B5E2-7D44-4A11-9E20-33A0B5E27D44">
            <File Id="WinTunLicenseFile" Source="WINTUN-LICENSE.txt" KeyPath="yes" />
          </Component>
        </Directory>
      </Directory>
    </Directory>
    <Feature Id="Main" Title="VEIL Desktop" Level="1">
      <ComponentRef Id="MainExecutable" />
      <ComponentRef Id="WinTunDll" />
      <ComponentRef Id="WinTunLicense" />
    </Feature>
  </Product>
</Wix>
EOF
touch -d "@${SOURCE_DATE_EPOCH}" "$work/veil.wxs"
(cd "$work" && wixl -a x64 -o "$out" veil.wxs)
PYTHONDONTWRITEBYTECODE=1 python3 "$root/scripts/normalize-msi.py" "$out" --epoch "$SOURCE_DATE_EPOCH" --package-code "$package_code"
