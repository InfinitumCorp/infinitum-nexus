"""Unpack androidx.webkit's classes.jar, and the two androidx.core classes it uses (PackageInfoCompat,
Pair) into core.jar, from the AARs fetch-deps.sh downloaded and checked.  usage: extract-aar.py DEPS_DIR
Jars rather than loose .class files: nested class paths can pass Windows' 260-character limit."""
import io, sys, zipfile
d = sys.argv[1]
with open(f"{d}/webkit.jar", "wb") as out:
    out.write(zipfile.ZipFile(f"{d}/dl/webkit.aar").read("classes.jar"))
core = zipfile.ZipFile(io.BytesIO(zipfile.ZipFile(f"{d}/dl/core.aar").read("classes.jar")))
with zipfile.ZipFile(f"{d}/core.jar", "w", zipfile.ZIP_DEFLATED) as out:
    for name in ("androidx/core/content/pm/PackageInfoCompat.class", "androidx/core/util/Pair.class"):
        out.writestr(name, core.read(name))
