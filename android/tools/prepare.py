#!/usr/bin/env python3
"""Build an ARM64 runtime and an allowlisted, credential-free app bundle."""
import hashlib, json, os, pathlib, shutil, subprocess, tarfile, urllib.request, zipfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
ANDROID=ROOT/'android'
CACHE=ANDROID/'.runtime-cache'
CACHE.mkdir(exist_ok=True)
PREFIX=CACHE/'root/data/data/com.termux/files/usr'
manifest=json.loads((ANDROID/'runtime-packages.json').read_text())
for package in manifest:
    archive=CACHE/(package['name']+'.deb')
    if not archive.exists(): urllib.request.urlretrieve(package['url'],archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest()!=package['sha256']: raise SystemExit('Runtime checksum mismatch: '+package['name'])
    subprocess.run(['ar','x',str(archive)],cwd=CACHE,check=True)
    data=next(CACHE.glob('data.tar.*'))
    with tarfile.open(data) as tar: tar.extractall(CACHE/'root',filter='data')
    data.unlink()
patchelf=shutil.which('patchelf') or os.environ.get('PATCHELF')
if not patchelf: raise SystemExit('Install patchelf or set PATCHELF to its executable.')
renames={'libz.so.1':'libz1.so','libcrypto.so.3':'libcrypto3.so','libssl.so.3':'libssl3.so','libicui18n.so.78':'libicui18n78.so','libicuuc.so.78':'libicuuc78.so','libicudata.so.78':'libicudata78.so'}
libs=['libz.so.1','libcares.so','libsqlite3.so','libcrypto.so.3','libssl.so.3','libicui18n.so.78','libicuuc.so.78','libicudata.so.78','libc++_shared.so']
native=ANDROID/'app/src/main/jniLibs/arm64-v8a'
native.mkdir(parents=True,exist_ok=True)
files={'libfishingnode.so':PREFIX/'bin/node'}
files.update({renames.get(name,name):PREFIX/'lib'/name for name in libs})
for name,source in files.items():
    target=native/name;shutil.copy2(source.resolve(),target);target.chmod(0o755)
    for old,new in renames.items(): subprocess.run([patchelf,'--replace-needed',old,new,str(target)],check=True)
    if name!='libfishingnode.so': subprocess.run([patchelf,'--set-soname',name,str(target)],check=True)
assets=ANDROID/'app/src/main/assets'
assets.mkdir(parents=True,exist_ok=True)
bundle=assets/'bot.zip'
# Never archive the workspace wholesale: only these generic sources and dependencies.
with zipfile.ZipFile(bundle,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as archive:
    for name in ['src','node_modules']:
        for file in sorted((ROOT/name).rglob('*')):
            if file.is_file() and not file.is_symlink(): archive.write(file,file.relative_to(ROOT).as_posix())
    for name in ['package.json','config.example.json']: archive.write(ROOT/name,name)
    archive.write(PREFIX/'etc/tls/cert.pem','cert.pem')
    for file in sorted((PREFIX/'share/doc').rglob('*')):
        if file.is_file() and file.name.lower() in ['copyright','license','license.txt']:
            archive.write(file,'runtime-notices/'+file.relative_to(PREFIX/'share/doc').as_posix())
    for file in sorted((ANDROID/'third-party').rglob('*')):
        if file.is_file(): archive.write(file,'runtime-notices/'+file.name)
(assets/'bot-version.txt').write_text(hashlib.sha256(bundle.read_bytes()).hexdigest())
print('Prepared ARM64 Node runtime and credential-free bot.zip ('+str(bundle.stat().st_size//1024//1024)+' MiB).')
