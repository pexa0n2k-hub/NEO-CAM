const $=id=>document.getElementById(id);
const video=$('preview'),statusText=$('statusText'),effectName=$('effectName');
const intensity=$('intensity'),intensityValue=$('intensityValue');
const zoom=$('zoom'),zoomValue=$('zoomValue'),cameraNote=$('cameraNote');
const recordBtn=$('record'),downloadBtn=$('download'),muteBtn=$('mute');
const switchBtn=$('switchCam'),micLevel=$('micLevel'),audioState=$('audioState'),recordTimer=$('recordTimer');

let stream=null,facing='user',audioCtx=null,source=null,destination=null,analyser=null;
let recorder=null,chunks=[],recordedUrl=null,current='normal',muted=false;
let timerRAF=0,startedAt=0,zoomNum=1,processor=null,graphInput=null,graphGain=null;

function setStatus(t){statusText.textContent=t}
function formatTime(ms){const s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
function startTimer(){
  startedAt=performance.now();recordTimer.classList.add('live');
  const tick=()=>{recordTimer.textContent=formatTime(performance.now()-startedAt);if(recorder?.state==='recording')timerRAF=requestAnimationFrame(tick)};
  cancelAnimationFrame(timerRAF);tick();
}
function stopTimer(){cancelAnimationFrame(timerRAF);recordTimer.classList.remove('live');recordTimer.textContent='00:00'}

function monitorMic(){
  if(!analyser)return;
  cancelAnimationFrame(window.__micRAF);
  const data=new Uint8Array(analyser.fftSize);
  const tick=()=>{
    analyser.getByteTimeDomainData(data);
    let sum=0;for(const v of data){const x=(v-128)/128;sum+=x*x}
    const rms=Math.sqrt(sum/data.length);
    micLevel.style.width=Math.min(100,Math.round(rms*1000))+'%';
    audioState.textContent=rms>.004?'MIC OK':'ESPERANDO MIC';
    audioState.style.color=rms>.004?'#55ff9a':'#ffb347';
    window.__micRAF=requestAnimationFrame(tick);
  };tick();
}

/*
 V1.11: the voice effects are now done in PCM with ScriptProcessorNode.
 This is intentionally simple and reliable on Android browsers:
 mic -> PCM processor -> MediaStreamDestination -> MediaRecorder.
 The robot effect is ring modulation, so it cannot accidentally become
 "just a clean voice with a filter".
*/
async function buildProcessedAudio(){
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC)throw Error('Web Audio no disponible');

  audioCtx=new AC({latencyHint:'interactive'});
  await audioCtx.resume();

  source=audioCtx.createMediaStreamSource(stream);
  destination=audioCtx.createMediaStreamDestination();
  analyser=audioCtx.createAnalyser();
  analyser.fftSize=1024;
  source.connect(analyser);

  // 4096-frame ScriptProcessor: supported by Android Chrome/WebView.
  processor=audioCtx.createScriptProcessor(4096,1,1);
  graphGain=audioCtx.createGain();
  graphGain.gain.value=1;

  source.connect(processor);
  processor.connect(graphGain);
  graphGain.connect(destination);

  let phase=0;
  processor.onaudioprocess=e=>{
    const input=e.inputBuffer.getChannelData(0);
    const output=e.outputBuffer.getChannelData(0);
    const sr=audioCtx.sampleRate;
    const p=Number(intensity.value)/100;

    for(let i=0;i<input.length;i++){
      const x=input[i];

      if(current==='robot'){
        // 55-95 Hz ring modulation. At 100%, almost all of the
        // carrier is modulated; 20% clean signal preserves words.
        const carrierHz=55+p*40;
        phase += 2*Math.PI*carrierHz/sr;
        if(phase>Math.PI*2)phase-=Math.PI*2;
        const ring=Math.sin(phase);
        const processed=x*ring;
        const clean=x*(1-p*.80);
        output[i]=(clean+processed*(.25+p*.95))*0.92;

      }else if(current==='demon'){
        // Pitch-like character using asymmetric waveshaping + bass emphasis.
        const driven=Math.tanh(x*(1+7*p));
        output[i]=(.62*x*(1-p*.55)+.75*driven*p);

      }else if(current==='radio'){
        // Narrow-band radio character.
        const clipped=Math.max(-.55,Math.min(.55,x*1.5));
        output[i]=(.35*x*(1-p*.7)+clipped*.75*p);

      }else if(current==='glitch'){
        // Periodic hard gating / bit reduction.
        const block=Math.floor((i+e.playbackTime*sr)/Math.max(1,220-p*160));
        const gate=(block%7===0)?0.18:1;
        const bits=Math.round(x*24)/24;
        output[i]=(x*(1-p*.55)+bits*.55*p)*gate;

      }else{
        output[i]=x;
      }
    }
  };

  monitorMic();
}

async function startCamera(){
  if(stream)stream.getTracks().forEach(t=>t.stop());

  stream=await navigator.mediaDevices.getUserMedia({
    video:{facingMode:{ideal:facing},width:{ideal:1920},height:{ideal:1080}},
    audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
  });

  video.srcObject=stream;
  await video.play();

  zoomNum=1;zoom.value=1;zoomValue.textContent='1.0×';
  video.style.transform='scale(1)';
  cameraNote.textContent='VISTA COMPLETA · 1.0×';

  micLevel.style.width='0%';
  audioState.textContent='MICRÓFONO LISTO';
  setStatus('CÁMARA LISTA');
}

async function applyZoom(){
  const track=stream?.getVideoTracks?.()[0];if(!track)return;
  const caps=track.getCapabilities?.()||{};
  if(caps.zoom){
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

document.querySelectorAll('.effect').forEach(btn=>btn.addEventListener('click',()=>{
  document.querySelectorAll('.effect').forEach(x=>x.classList.remove('active'));
  btn.classList.add('active');
  current=btn.dataset.effect;
  effectName.textContent=current.toUpperCase();
}));

intensity.addEventListener('input',()=>{
  intensityValue.textContent=intensity.value+'%';
});

zoom.addEventListener('input',applyZoom);

muteBtn.addEventListener('click',()=>{
  muted=!muted;
  muteBtn.textContent=muted?'🔇':'🎙️';
  const t=stream?.getAudioTracks?.()[0];
  if(t)t.enabled=!muted;
});

switchBtn.addEventListener('click',async()=>{
  facing=facing==='user'?'environment':'user';
  try{await startCamera()}catch(e){console.error(e);setStatus('NO SE PUDO CAMBIAR')}
});

recordBtn.addEventListener('click',async()=>{
  if(recorder?.state==='recording'){recorder.stop();return}

  try{
    if(!stream)await startCamera();

    let mediaStream;

    if(current==='normal'){
      // Proven path: direct microphone track.
      const t=stream.getAudioTracks()[0];
      if(!t)throw Error('No existe pista de micrófono');
      t.enabled=!muted;
      mediaStream=new MediaStream([stream.getVideoTracks()[0],t]);

    }else{
      // NEW: PCM-processed track.
      await buildProcessedAudio();
      const t=destination?.stream?.getAudioTracks?.()[0];
      if(!t)throw Error('No existe pista procesada');
      t.enabled=!muted;
      mediaStream=new MediaStream([stream.getVideoTracks()[0],t]);
    }

    chunks=[];
    const types=[
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm'
    ];
    const mime=types.find(x=>MediaRecorder.isTypeSupported(x))||'';

    recorder=new MediaRecorder(
      mediaStream,
      mime?{mimeType:mime,audioBitsPerSecond:128000,videoBitsPerSecond:5000000}:undefined
    );

    recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data)};
    recorder.onerror=e=>{
      console.error(e);
      recordBtn.classList.remove('recording');
      stopTimer();
      setStatus('ERROR DE GRABACIÓN');
    };

    recorder.onstop=()=>{
      recordBtn.classList.remove('recording');
      stopTimer();

      if(processor)processor.disconnect();
      if(audioCtx){try{audioCtx.close()}catch{}}
      processor=null;audioCtx=null;destination=null;source=null;analyser=null;

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

      setStatus('VIDEO LISTO · '+(current==='normal'?'MICRÓFONO':'FILTRO '+current.toUpperCase()));
    };

    recorder.start(250);
    recordBtn.classList.add('recording');
    setStatus('GRABANDO · '+current.toUpperCase());
    startTimer();

  }catch(e){
    console.error(e);
    recordBtn.classList.remove('recording');
    stopTimer();
    setStatus('ERROR DE AUDIO');
  }
});

recordTimer.textContent='00:00';

(async()=>{
  try{await startCamera()}
  catch(e){console.error(e);setStatus('PERMISO DE CÁMARA REQUERIDO')}
})();
