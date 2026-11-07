#!/usr/bin/env bash
# Builds an unsigned per-machine MSI with wixl. No Authenticode signature.
set -euo pipefail
src="${1:?windows directory}"
out="${2:?msi path}"
if ! command -v wixl >/dev/null 2>&1; then
  echo "wixl is not installed; MSI was not produced" >&2
  exit 0
fi
work="$(mktemp -d)"
cat > "$work/veil.wxs" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="VEIL Desktop" Language="1033" Version="0.9.0"
           Manufacturer="Infinitum Corporation" UpgradeCode="8D6A1B2E-4C70-4E1A-9B5A-6E0A7C1D4F10">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" Description="Infinitum Corporation VEIL Desktop" />
    <MediaTemplate EmbedCab="yes" />
    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLFOLDER" Name="VEIL Desktop">
          <Component Id="MainExecutable" Guid="C1A0B5E2-7D44-4A11-9E20-11A0B5E27D44">
            <File Id="VeilExe" Source="${src}/veil-desktop.exe" KeyPath="yes" />
          </Component>
          <Component Id="WinTunDll" Guid="C1A0B5E2-7D44-4A11-9E20-22A0B5E27D44">
            <File Id="WinTunFile" Source="${src}/wintun.dll" KeyPath="yes" />
          </Component>
          <Component Id="WinTunLicense" Guid="C1A0B5E2-7D44-4A11-9E20-33A0B5E27D44">
            <File Id="WinTunLicenseFile" Source="${src}/WINTUN-LICENSE.txt" KeyPath="yes" />
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
wixl -a x64 -o "$out" "$work/veil.wxs"
rm -rf "$work"
file "$out" || true
