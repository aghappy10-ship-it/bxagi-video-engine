"""Package reproducible, secret-free v2.2 sources and retained local video tools."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
target = root / 'public/downloads/BXAGI_Advertising_Platform_2.2_Source.zip'
target.parent.mkdir(parents=True, exist_ok=True)
files = []
for name in ['README.md','start.sh','start.bat','Dockerfile','Dockerfile.legacy','.dockerignore','.gitignore','.npmrc','package.json','package-lock.json','tsconfig.json','cloudflare-env.d.ts','components.json','drizzle.config.ts','eslint.config.mjs','next.config.ts','postcss.config.mjs','vite.config.ts','wrangler.standalone.jsonc']:
    path=root/name
    if path.is_file(): files.append(path)
for folder in ['app','components','features','styles','server','shared','db','drizzle','worker','backend','legacy','docs','tests','scripts','build','lib','hooks','vendor','public']:
    for path in (root/folder).rglob('*'):
        relative=path.relative_to(root)
        if not path.is_file() or any(part in {'__pycache__','data','runtime','downloads','tmp','node_modules','.sites-runtime'} for part in relative.parts): continue
        if path.suffix in {'.pyc','.zip','.tar','.gz','.sqlite3','.tsbuildinfo'} or path.name.startswith('.env'): continue
        files.append(path)
files=sorted(set(files))
manifest={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
def write(z,path,data):
    info=zipfile.ZipInfo('BXAGI_Advertising_Platform/'+path,date_time=(2026,10,15,0,0,0))
    info.compress_type=zipfile.ZIP_DEFLATED
    info.external_attr=(0o755 if path.endswith('.sh') else 0o644)<<16
    z.writestr(info,data)
with zipfile.ZipFile(target,'w') as z:
    for path in files: write(z,str(path.relative_to(root)),path.read_bytes())
    write(z,'MANIFEST_SHA256.json',json.dumps(manifest,indent=2,ensure_ascii=False).encode())
with zipfile.ZipFile(target) as z:
    assert z.testzip() is None
    for path in ['server/platform-api.mjs','app/page.tsx','features/account/login-form.tsx','features/projects/new-project.tsx','features/library/resource-card.tsx','styles/platform/shell.css','server/platform/protocol.mjs','server/bxagi/employee-routing.mjs','worker/run.py','drizzle/0000_hard_vulture.sql','drizzle/0001_adorable_forgotten_one.sql','drizzle/0002_fuzzy_warstar.sql','server/bxagi-orchestrator.mjs','server/bxagi-auth.mjs','backend/server.py','legacy/workspace/index.html']:
        assert 'BXAGI_Advertising_Platform/'+path in z.namelist(), path
    for path in ['server/production-service.mjs','server/delivery-groups.mjs','server/settings-service.mjs','server/insights-service.mjs','server/platform/business-routes.mjs','features/delivery/group-form.tsx','features/settings/settings-panels.tsx','drizzle/0003_dazzling_madripoor.sql','drizzle/0004_spooky_blue_marvel.sql','docs/EIGHT_MODULE_PLATFORM.md']:
        assert 'BXAGI_Advertising_Platform/'+path in z.namelist(), path
# Retain existing source and local-tool download URLs.
(root/'public/downloads/BXAGI_Advertising_Platform_2.1_Source.zip').write_bytes(target.read_bytes())
(root/'public/downloads/BXAGI_Advertising_Platform_2.0_Source.zip').write_bytes(target.read_bytes())
(root/'public/downloads/BXAGI_Video_MVP.zip').write_bytes(target.read_bytes())
print(f'Created {target.name}: {len(files)} files, {target.stat().st_size:,} bytes.')
