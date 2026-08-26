const $=id=>document.getElementById(id);
const video=$('preview'), statusText=$('statusText'), effectName=$('effectName');
const intensity=$('intensity'), intensityValue=$('intensityValue');
const zoom=$('zoom'), zoomValue=$('zoomValue'), cameraNote=$('cameraNote');
const recordBtn=$('record'), downloadBtn=$('download'), muteBtn=$('mute');
const switchBtn=$('switchCam'), micLevel=$('micLevel'), audioState=$('audioState');
const recordTimer=$('recordTimer');

let stream=null, facing='user', audioCtx=null, source=null, destination=null;
let analyser=null, recorder=null, chunks=[], recordedUrl=null;
let current='normal', muted=false, timerRAF=0, startedAt=0, zoomNum=1;

const effects={
  normal:{low:20, high:20000},
  robot:{low:160, high:5200},
  demon:{low:70, high:5000},
  radio:{low:350, high:3300},
  glitch:{low:120, high:7000}
};

function setStatus(t){ statusText.textContent=t; }

function formatTime(ms){
  const s=Math.floor(ms/1000);
  return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
}
function startTimer(){
  startedAt=performance.now();
  recordTimer.classList.add('live');
  const tick=()=>{
    recordTimer.textContent=formatTime(performance.now()-startedAt);
    if(recorder?.state==='recording') timerRAF=requestAnimationFrame(tick);
  };
  cancelAnimationFrame(timerRAF); tick();
}
function stopTimer(){
  cancelAnimationFrame(timerRAF);
  recordTimer.classList.remove('live');
  recordTimer.textContent='00:00';
}

function distortionCurve(amount){
  const n=32768, curve=new Float32Array(n), k=amount;
  for(let i=0;i<n;i++){
    const x=i*2/n-1;
    curve[i]=(1+k)*x/(1+k*Math.abs(x));
  }
  return curve;
}

async function buildAudio(){
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC) throw new Error('Web Audio no disponible');

  if(audioCtx) {
    try { await audioCtx.resume(); } catch {}
    if(audioCtx.state!=='closed') return;
  }

  audioCtx=new AC({latencyHint:'interactive'});
  await audioCtx.resume();

  // Create the graph only after the REC button is pressed.
  source=audioCtx.createMediaStreamSource(stream);
  destination=audioCtx.createMediaStreamDestination();

  const low=audioCtx.createBiquadFilter();
  const high=audioCtx.createBiquadFilter();
  const shaper=audioCtx.createWaveShaper();
  const compressor=audioCtx.createDynamicsCompressor();
  const cleanGain=audioCtx.createGain();
  const fxGain=audioCtx.createGain();
  const master=audioCtx.createGain();

  low.type='lowpass';
  high.type='highpass';
  compressor.threshold.value=-18;
  compressor.knee.value=18;
  compressor.ratio.value=3;
  compressor.attack.value=.003;
  compressor.release.value=.15;

  analyser=audioCtx.createAnalyser();
  analyser.fftSize=1024;
  source.connect(analyser);

  // Processed chain. No oscillator/modulation is used here;
  // this keeps Android recording compatibility high.
  source.connect(low).connect(high).connect(shaper).connect(compressor);
  compressor.connect(fxGain).connect(master);

  // Clean path is mixed in for intelligibility.
  source.connect(cleanGain).connect(master);
  master.connect(destination);

  nodes={low,high,shaper,cleanGain,fxGain,master};
  monitorMic();
  applyEffect();
}

function applyEffect(){
  if(!nodes || !audioCtx) return;
  const e=effects[current], p=Number(intensity.value)/100;

  nodes.low.frequency.setTargetAtTime(
    e.low + (20-e.low)*(1-p), audioCtx.currentTime, .01
  );
  nodes.high.frequency.setTargetAtTime(
    e.high + (20000-e.high)*(1-p), audioCtx.currentTime, .01
  );

  // Mild nonlinearity only. Strong distortion destroys intelligibility.
  const amount=current==='robot'?0.18:
               current==='demon'?0.12:
               current==='radio'?0.08:
               current==='glitch'?0.22:0;
  nodes.shaper.curve=distortionCurve(amount*p);

  if(current==='normal'){
    nodes.cleanGain.gain.value=1;
    nodes.fxGain.gain.value=0;
  } else {
    // Always keep a clean component so speech remains understandable.
    nodes.cleanGain.gain.value=Math.max(.45,1-p*.45);
    nodes.fxGain.gain.value=Math.min(.9,.25+p*.65);
  }
  effectName.textContent=current.toUpperCase();
}

function monitorMic(){
  if(!analyser)return;
  cancelAnimationFrame(window.__micRAF);
  const data=new Uint8Array(analyser.fftSize);
  const tick=()=>{
    analyser.getByteTimeDomainData(data);
    let sum=0;
    for(const v of data){const x=(v-128)/128;sum+=x*x}
    const rms=Math.sqrt(sum/data.length);
    micLevel.style.width=Math.min(100,Math.round(rms*1000))+'%';
    audioState.textContent=rms>.004?'MIC OK':'ESPERANDO MIC';
    audioState.style.color=rms>.004?'#55ff9a':'#ffb347';
    window.__micRAF=requestAnimationFrame(tick);
  };
  tick();
}

async function startCamera(){
  if(stream) stream.getTracks().forEach(t=>t.stop());

  stream=await navigator.mediaDevices.getUserMedia({
    video:{
      facingMode:{ideal:facing},
      width:{ideal:1920},
      height:{ideal:1080}
    },
    audio:{
      echoCancellation:true,
      noiseSuppression:true,
      autoGainControl:true
    }
  });

  video.srcObject=stream;
  await video.play();

  zoomNum=1;
  zoom.value=1;
  zoomValue.textContent='1.0×';
  video.style.transform='scale(1)';
  cameraNote.textContent='VISTA COMPLETA · 1.0×';

  // Do NOT create AudioContext here. Android is more reliable
  // when it is created from the REC click.
  audioCtx=null; source=null; destination=null; analyser=null; nodes=null;
  micLevel.style.width='0%';
  audioState.textContent='MICRÓFONO LISTO';
  setStatus('CÁMARA LISTA');
}

async function applyZoom(){
  const track=stream?.getVideoTracks?.()[0];
  if(!track)return;

  const caps=track.getCapabilities?.()||{};
  if(caps.zoom){
    const min=caps.zoom.min??1, max=Math.min(caps.zoom.max??4,4);
    if(Number(zoom.value)<min) zoom.value=min;
    zoomNum=Number(zoom.value);
    try{
      await track.applyConstraints({advanced:[{zoom:zoomNum}]});
      video.style.transform='scale(1)';
      cameraNote.textContent='ZOOM CÁMARA · '+zoomNum.toFixed(1)+'×';
      zoomValue.textContent=zoomNum.toFixed(1)+'×';
      return;
    }catch{}
  }

  zoomNum=Number(zoom.value);
  video.style.transform=`scale(${zoomNum})`;
  zoomValue.textContent=zoomNum.toFixed(1)+'×';
  cameraNote.textContent='ZOOM DIGITAL · '+zoomNum.toFixed(1)+'×';
}

document.querySelectorAll('.effect').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.effect').forEach(x=>x.classList.remove('active'));
    btn.classList.add('active');
    current=btn.dataset.effect;
    if(audioCtx) applyEffect();
  });
});

intensity.addEventListener('input',()=>{
  intensityValue.textContent=intensity.value+'%';
  if(audioCtx) applyEffect();
});

zoom.addEventListener('input',applyZoom);

muteBtn.addEventListener('click',()=>{
  muted=!muted;
  muteBtn.textContent=muted?'🔇':'🎙️';
  const t=stream?.getAudioTracks?.()[0];
  if(t) t.enabled=!muted;
});

switchBtn.addEventListener('click',async()=>{
  facing=facing==='user'?'environment':'user';
  try { await startCamera(); }
  catch(e){ console.error(e); setStatus('NO SE PUDO CAMBIAR'); }
});

recordBtn.addEventListener('click',async()=>{
  if(recorder?.state==='recording'){
    recorder.stop();
    return;
  }

  try{
    if(!stream) await startCamera();

    // IMPORTANT:
    // NORMAL records the original getUserMedia stream directly.
    // This is the most reliable Android path and guarantees microphone audio.
    let mediaStream;
    if(current==='normal'){
      const audioTrack=stream.getAudioTracks()[0];
      if(!audioTrack) throw new Error('No existe pista de micrófono');
      audioTrack.enabled=!muted;
      mediaStream=new MediaStream([
        stream.getVideoTracks()[0],
        audioTrack
      ]);
      recordingAudioMode='MICRÓFONO';
    }else{
      await buildAudio();
      const processed=destination?.stream?.getAudioTracks?.()[0];
      if(!processed) throw new Error('No existe pista procesada');
      processed.enabled=!muted;
      mediaStream=new MediaStream([
        stream.getVideoTracks()[0],
        processed
      ]);
      recordingAudioMode='FILTRO '+current.toUpperCase();
    }

    chunks=[];

    const supported=[
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm'
    ];
    const mime=supported.find(x=>MediaRecorder.isTypeSupported(x))||'';

    recorder=new MediaRecorder(
      mediaStream,
      mime?{mimeType:mime,audioBitsPerSecond:128000,videoBitsPerSecond:5000000}:undefined
    );

    recorder.ondataavailable=e=>{
      if(e.data?.size) chunks.push(e.data);
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
      if(recordedUrl) URL.revokeObjectURL(recordedUrl);
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
    setStatus('ERROR DE MICRÓFONO');
  }
});

recordTimer.textContent='00:00';

(async()=>{
  try{ await startCamera(); }
  catch(e){
    console.error(e);
    setStatus('PERMISO DE CÁMARA REQUERIDO');
  }
})();
