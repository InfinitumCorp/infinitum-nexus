"""Append files to an APK with forward-slash paths (aapt2 -A and jar both misbehave on Windows).
usage: add-to-apk.py APK PREFIX DIR   -> adds DIR/** as PREFIX/**
       add-to-apk.py APK FILE         -> adds FILE at the root"""
import os, sys, zipfile
apk = sys.argv[1]
with zipfile.ZipFile(apk, "a", zipfile.ZIP_DEFLATED) as z:
    if len(sys.argv) == 3:
        z.write(sys.argv[2], os.path.basename(sys.argv[2]))
    else:
        prefix, root = sys.argv[2], sys.argv[3]
        for dirpath, _, files in os.walk(root):
            for f in sorted(files):
                full = os.path.join(dirpath, f)
                rel = os.path.relpath(full, root).replace(os.sep, "/")
                z.write(full, f"{prefix}/{rel}")
