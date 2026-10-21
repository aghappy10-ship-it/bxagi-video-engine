"""Run the real HTTP video pipeline against synthetic input and retain evidence."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
target = ROOT / 'legacy' / 'workspace' / 'samples' / 'verified_output.mp4'
evidence = ROOT / 'legacy' / 'workspace' / 'samples' / 'verification.json'
with tempfile.TemporaryDirectory(prefix='bxagi-e2e-') as work:
    with socket.socket() as probe:
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
    token = secrets.token_urlsafe(24)
    env = {**os.environ, 'BX_API_TOKEN': token}
    # Never inherit enabled provider configuration in verification.
    env['BX_MODEL_ENABLED'] = 'false'
    proc = subprocess.Popen(['python3', 'backend/server.py', '--port', str(port),
            '--data-dir', work, '--workers', '1'], cwd=ROOT, env=env,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    base = f'http://127.0.0.1:{port}'
    def request(path, body=None, headers=None):
        raw = json.dumps(body).encode() if isinstance(body, dict) else body
        h = {'Authorization': f'Bearer {token}'}
        if isinstance(body, dict): h['Content-Type'] = 'application/json'
        h.update(headers or {})
        with urlopen(Request(base+path, data=raw, headers=h), timeout=30) as r:
            content = r.read()
            return json.loads(content) if 'application/json' in r.headers.get('Content-Type', '') else content
    try:
        deadline=time.monotonic()+10
        while True:
            try: request('/api/health');break
            except (URLError,HTTPError):
                if time.monotonic()>deadline:raise RuntimeError('Test service did not start')
                time.sleep(.1)
        asset=request('/api/assets',(ROOT/'legacy/workspace/samples/bxagi_sample.mp4').read_bytes(),{'X-Filename':'bxagi_sample.mp4','Content-Type':'video/mp4'})
        request(f"/api/assets/{asset['id']}/transcript",{'srt':(ROOT/'legacy/workspace/samples/bxagi_sample.srt').read_text()})
        plan=request(f"/api/assets/{asset['id']}/plan",{'count':3,'min_duration':4,'max_duration':8,'strategy':'hook','use_ai':False})
        assert plan['clips'], 'No real clip plan'
        task=request('/api/jobs',{'asset_id':asset['id'],'title':'Synthetic sample: two complete sentence windows',
                'clips':[{'start':0,'end':8},{'start':12,'end':20}],'format':'portrait','burn_subtitles':False})
        deadline=time.monotonic()+60
        while True:
            job=request(f"/api/jobs/{task['id']}")
            if job['status'] in ('passed','failed'):break
            if time.monotonic()>deadline:raise RuntimeError('FFmpeg export timed out')
            time.sleep(.2)
        assert job['status']=='passed', job
        assert job['gates']['passed'] is True, job['gates']
        target.write_bytes(request(f"/api/jobs/{task['id']}/download"))
        subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-i',str(target),'-f','null','-'],check=True,capture_output=True)
        info=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(target)]))
        video=next(s for s in info['streams'] if s['codec_type']=='video')
        assert video['width']==720 and video['height']==1280
        assert abs(float(info['format']['duration'])-16)<.2
        report={'version':'1.1.0','source':'Programmatically generated test pattern with tone; subtitles describe the test, not speech recognition.',
                'clips':[{'start':0,'end':8},{'start':12,'end':20}],
                'width':video['width'],'height':video['height'],'measured_duration':float(info['format']['duration']),
                'full_decode_passed':True,'technical_gates':job['gates'],'semantic_ai_verified':False,
                'burn_subtitles':False,
                'actual_model_inference_verified':False,'actual_ad_execution_verified':False,
                'browser_visual_qa_performed':False,'output':'verified_output.mp4'}
        evidence.write_text(json.dumps(report,ensure_ascii=False,indent=2))
        print('PASS: HTTP upload → SRT → plan → two-window portrait export → gates → authenticated MP4 download → full decode; 720×1280, ~16 seconds.')
    finally:
        proc.terminate()
        try:proc.wait(timeout=8)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()
