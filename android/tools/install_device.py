#!/usr/bin/env python3
"""Install and optionally provision one explicitly connected Android device.
Credentials travel through ADB stdin, never through APK assets or shell arguments.
"""
import argparse,json,pathlib,re,subprocess,time
ROOT=pathlib.Path(__file__).resolve().parents[2]
PACKAGE='org.fishingbot.android'
parser=argparse.ArgumentParser()
parser.add_argument('--serial')
parser.add_argument('--provision',action='store_true',help='Copy ignored local settings, auth cache and statistics into app-private storage')
parser.add_argument('--stop-desktop',action='store_true',help='Stop the desktop systemd bot before provisioning the same account')
args=parser.parse_args()
rows=subprocess.check_output(['adb','devices'],text=True).splitlines()[1:]
devices=[row.split()[0] for row in rows if len(row.split())>=2 and row.split()[1]=='device']
serial=args.serial or (devices[0] if len(devices)==1 else None)
if not serial or serial not in devices: raise SystemExit('Connect exactly one authorized device or pass --serial.')
adb=['adb','-s',serial]
def run(*command,**kwargs): return subprocess.run(adb+list(command),check=True,**kwargs)
def private_file(path,data):
    run('shell','-T','run-as',PACKAGE,'tee','files/bot/'+path,input=data,stdout=subprocess.DEVNULL)
    run('shell','run-as',PACKAGE,'chmod','600','files/bot/'+path,stdout=subprocess.DEVNULL)
apk=ROOT/'android/app/build/outputs/apk/debug/app-debug.apk'
run('install','-r','-g',str(apk))
run('shell','am','start','-n',PACKAGE+'/.MainActivity',stdout=subprocess.DEVNULL)
expected=(ROOT/'android/app/src/main/assets/bot-version.txt').read_bytes()
for attempt in range(120):
    marker=subprocess.run(adb+['exec-out','run-as',PACKAGE,'cat','files/bot/.bundle-version'],capture_output=True)
    ready=marker.stdout==expected
    if ready: break
    time.sleep(1)
else: raise SystemExit('Runtime extraction is still pending; unlock the device and reopen the app.')
if args.provision:
    if args.stop_desktop: subprocess.run(['systemctl','--user','stop','fishingbot.service'],check=True)
    for name in ['.env','config.json']:
        if not (ROOT/name).exists(): raise SystemExit('Missing local '+name+'; no credentials were printed.')
    config=json.loads((ROOT/'config.json').read_text())
    config['storage']={'stateFile':'data/state.json','authDirectory':'auth-cache'}
    config['fishing']['autoStart']=False
    private_file('config.json',(json.dumps(config,indent=2)+'\n').encode())
    private_file('.env',(ROOT/'.env').read_bytes())
    run('shell','run-as',PACKAGE,'mkdir','-p','files/bot/auth-cache','files/bot/data')
    for file in (ROOT/'auth-cache').glob('*.json'):
        if re.fullmatch(r'[A-Za-z0-9_.-]+',file.name): private_file('auth-cache/'+file.name,file.read_bytes())
    state=ROOT/'data/state.json'
    existing=subprocess.run(adb+['shell','-T','run-as',PACKAGE,'test','-f','files/bot/data/state.json'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if state.exists() and existing.returncode!=0: private_file('data/state.json',state.read_bytes())
    print('Private settings, existing Microsoft cache and statistics provisioned. Initial fishing is paused.')
run('shell','dumpsys','deviceidle','whitelist','+'+PACKAGE,stdout=subprocess.DEVNULL)
for operation in ['RUN_IN_BACKGROUND','RUN_ANY_IN_BACKGROUND']:
    result=subprocess.run(adb+['shell','appops','set',PACKAGE,operation,'allow'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    if result.returncode: print('Device restricts ADB app-ops changes; verify background allowance in Android App info.')
print('App installed with notifications and background battery exemption. Open the app and tap Start bot.')
