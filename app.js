const $=id=>document.getElementById(id);
const video=$('preview'),statusText=$('statusText'),effectName=$('effectName');
const intensity=$('intensity'),intensityValue=$('intensityValue'),zoom=$('zoom'),zoomValue=$('zoomValue');
const recordBtn=$('record'),downloadBtn=$('download'),muteBtn=$('mute'),switchBtn=$('switchCam');
const cameraNote=$('cameraNote'),micLevel=$('micLevel'),audioState=$('audioState'),recordTimer=$('recordTimer');

let facing='user',stream=null,audioCtx=null,source=null,destination=null,recorder=null,chunks=[];
let current='normal',muted=false,recordedUrl=null,inputAnalyser=null,raf=0,timerId=0,startedAt=0;
let nodes=null,hardwareZoom=false,zoomValueNum=1,recordingAudioMode='';

const effects={
  normal:{low:20,high:20000,dist:0},
  robot:{low:130,high:6200,dist:10},
  demon:{low:60,high:6000,dist:7},
  radio:{low:320,high:3400,dist:4},
  glitch:{low:100,high:7600,dist:14}
};

function curve(amount){
  const n=44100,c=new Float32Array(n),k=Math.max(0,amount)/100*3;
  for(let i=0;i<n;i++){
    const x=i*2/n-1;
    c[i]=(1+k)*x/(1+k*Math.abs(x));
  }
  return c;
}

function applyEffect(){
  if(!nodes)return;
  const e=effects[current], p=Number(intensity.value)/100;

  nodes.low.frequency.setTargetAtTime(e.low, audioCtx.currentTime, .01);
  nodes.high.frequency.setTargetAtTime(e.high, audioCtx.currentTime, .01);
  nodes.dist.curve=curve(e.dist*p);
  nodes.dist.oversample='2x';

  // Always keep a clean path in the mix. This prevents the processed
  // branch from becoming the only audible/recordable signal.
  if(current==='normal'){
    nodes.clean.gain.value=muted?0:1;
    nodes.fx.gain.value=0;
    nodes.modDepth.gain.value=0;
  }else{
    const cleanAmount=Math.max(.35,1-(p*.55));
    nodes.clean.gain.value=muted?0:cleanAmount;
    nodes.fx.gain.value=muted?0:Math.min(.75,.18+p*.58);
    nodes.modDepth.gain.value=current==='robot' ? (.02+p*.16) :
                             current==='glitch' ? (.01+p*.09) : 0;
  }

  nodes.tone.frequency.value=current==='radio'?3400:
                              current==='robot'?6200:
                              current==='demon'?5000:
                              current==='glitch'?7600:20000;

  nodes.mod.frequency.value=current==='robot'?38:
                           current==='glitch'?17:0;

  effectName.textContent=current.toUpperCase();
}

function rms(an){
  if(!an)return 0;
  const d=new Uint8Array(an.fftSize);
  an.getByteTimeDomainData(d);
  let s=0;
  for(const v of d){const x=(v-128)/128;s+=x*x}
  return Math.sqrt(s/d.length);
}

function monitorMic(){
  cancelAnimationFrame(raf);
  const tick=()=>{
    const r=rms(inputAnalyser);
    const p=Math.min(100,Math.round(r*900));
    micLevel.style.width=p+'%';
    audioState.textContent=r>.004?'MIC OK':'ESPERANDO MIC';
    audioState.style.color=r>.004?'#55ff9a':'#ffb347';
    raf=requestAnimationFrame(tick);
  };
  tick();
}

function formatTime(ms){
  const s=Math.floor(ms/1000);
  return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
}

function startTimer(){
  startedAt=performance.now();
  recordTimer.classList.add('live');
  cancelAnimationFrame(timerId);
  const tick=()=>{
    recordTimer.textContent=formatTime(performance.now()-startedAt);
    if(recorder?.state==='recording')timerId=requestAnimationFrame(tick);
  };
  tick();
}

function stopTimer(){
  cancelAnimationFrame(timerId);
  recordTimer.classList.remove('live');
  recordTimer.textContent='00:00';
}

function setStatus(t){statusText.textContent=t}

async function ensureAudioGraph(){
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC)throw Error('Web Audio no disponible');

  if(audioCtx && audioCtx.state==='closed') audioCtx=null;

  if(!audioCtx){
    // Created from the REC button gesture for better Android compatibility.
    audioCtx=new AC({latencyHint:'interactive'});
    source=audioCtx.createMediaStreamSource(stream);
    destination=audioCtx.createMediaStreamDestination();

    const input=audioCtx.createGain();
    const low=audioCtx.createBiquadFilter();
    const high=audioCtx.createBiquadFilter();
    const dist=audioCtx.createWaveShaper();
    const clean=audioCtx.createGain();
    const fx=audioCtx.createGain();
    const tone=audioCtx.createBiquadFilter();
    const mod=audioCtx.createOscillator();
    const modDepth=audioCtx.createGain();
    const carrier=audioCtx.createGain();
    const master=audioCtx.createGain();

    low.type='lowpass';
    high.type='highpass';
    tone.type='lowpass';

    inputAnalyser=audioCtx.createAnalyser();
    inputAnalyser.fftSize=1024;

    source.connect(inputAnalyser);
    source.connect(input);
    input.connect(low).connect(high).connect(dist);

    // Clean voice path
    dist.connect(clean);

    // FX path
    dist.connect(tone).connect(carrier);
    mod.connect(modDepth);
    modDepth.connect(carrier.gain);

    clean.connect(master);
    carrier.connect(fx);
    fx.connect(master);
    master.connect(destination);

    // Do not route mic to speakers: this avoids echo and feedback.
    master.gain.value=1;
    clean.gain.value=1;
    fx.gain.value=0;
    modDepth.gain.value=0;
    mod.start();

    nodes={input,low,high,dist,clean,fx,tone,mod,modDepth,carrier,master};

    await audioCtx.resume();
    applyEffect();
    monitorMic();
  }else{
    await audioCtx.resume();
    applyEffect();
  }

  const track=destination.stream.getAudioTracks()[0];
  if(!track)throw Error('No se pudo crear la pista de audio');
  track.enabled=!muted;
  return track;
}

async function startCamera(){
  if(stream)stream.getTracks().forEach(t=>t.stop());

  stream=await navigator.mediaDevices.getUserMedia({
    video:{facingMode:facing,width:{ideal:1920},height:{ideal:1080}},
    audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
  });

  video.srcObject=stream;
  await video.play();

  zoomValueNum=1;
  zoom.value=1;
  zoomValue.textContent='1.0×';
  video.style.transform='scale(1)';

  // Audio graph is intentionally NOT created here. On Android it is
  // more reliable when initialized by the REC button gesture.
  inputAnalyser=null;
  audioState.textContent='MICRÓFONO LISTO';
  micLevel.style.width='0%';

  await applyZoom();
  setStatus('CÁMARA LISTA');
}

async function applyZoom(){
  const track=stream?.getVideoTracks()[0];
  if(!track)return;
  const caps=track.getCapabilities?.()||{};
  hardwareZoom=typeof caps.zoom==='object';

  if(hardwareZoom){
    zoom.min=caps.zoom.min??1;
    zoom.max=Math.min(caps.zoom.max??4,4);
    try{
      await track.applyConstraints({advanced:[{zoom:zoomValueNum}]});
      video.style.transform='scale(1)';
    }catch{
      hardwareZoom=false;
    }
  }

  if(!hardwareZoom)video.style.transform=`scale(${Math.max(1,zoomValueNum)})`;
  zoomValue.textContent=zoomValueNum.toFixed(1)+'×';
  cameraNote.textContent=(hardwareZoom?'ZOOM CÁMARA':'ZOOM DIGITAL')+' · '+zoomValueNum.toFixed(1)+'×';
}

document.querySelectorAll('.effect').forEach(b=>b.onclick=()=>{
  document.querySelectorAll('.effect').forEach(x=>x.classList.remove('active'));
  b.classList.add('active');
  current=b.dataset.effect;
  if(audioCtx)applyEffect();
});

intensity.oninput=()=>{
  intensityValue.textContent=intensity.value+'%';
  if(audioCtx)applyEffect();
};

zoom.oninput=async()=>{
  zoomValueNum=Number(zoom.value);
  await applyZoom();
};

muteBtn.onclick=()=>{
  muted=!muted;
  muteBtn.textContent=muted?'🔇':'🎙️';
  if(audioCtx)applyEffect();
};

switchBtn.onclick=async()=>{
  facing=facing==='user'?'environment':'user';
  try{
    await startCamera();
  }catch(e){
    console.error(e);
    setStatus('NO SE PUDO CAMBIAR');
  }
};

recordBtn.onclick=async()=>{
  if(recorder?.state==='recording'){
    recorder.stop();
    return;
  }

  try{
    if(!stream)await startCamera();

    const audioTrack=await ensureAudioGraph();
    const videoTrack=stream.getVideoTracks()[0];

    if(!videoTrack || !audioTrack)throw Error('No hay pistas de video/audio');

    chunks=[];

    // Fresh combined stream every time. This avoids reusing a stale track.
    const combined=new MediaStream([videoTrack,audioTrack]);

    const types=[
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm'
    ];
    const mime=types.find(t=>MediaRecorder.isTypeSupported(t))||'';

    recorder=new MediaRecorder(
      combined,
      mime ? {mimeType:mime,audioBitsPerSecond:128000,videoBitsPerSecond:5000000} : undefined
    );

    recordingAudioMode=current==='normal'?'MICRÓFONO':'FILTRO '+current.toUpperCase();

    recorder.ondataavailable=e=>{
      if(e.data?.size)chunks.push(e.data);
    };

    recorder.onerror=e=>{
      console.error(e);
      recordBtn.classList.remove('recording');
      stopTimer();
      setStatus('ERROR DE GRABACIÓN');
    };

    recorder.onstop=()=>{
      recordBtn.classList.remove('recording');
      stopTimer();

      const blob=new Blob(chunks,{type:recorder.mimeType||'video/webm'});
      if(recordedUrl)URL.revokeObjectURL(recordedUrl);
      recordedUrl=URL.createObjectURL(blob);

      downloadBtn.disabled=false;
      downloadBtn.onclick=()=>{
        const a=document.createElement('a');
        a.href=recordedUrl;
        a.download='neo-cam-'+Date.now()+'.webm';
        a.click();
      };

      setStatus('VIDEO LISTO · '+recordingAudioMode);
    };

    recorder.start(250);
    recordBtn.classList.add('recording');
    setStatus('GRABANDO · '+recordingAudioMode);
    startTimer();

  }catch(e){
    console.error(e);
    recordBtn.classList.remove('recording');
    stopTimer();
    setStatus('MIC/GRABACIÓN NO DISPONIBLE');
  }
};

recordTimer.textContent='00:00';

(async()=>{
  try{
    await startCamera();
  }catch(e){
    console.error(e);
    setStatus('PERMISO DE CÁMARA REQUERIDO');
  }
})();
