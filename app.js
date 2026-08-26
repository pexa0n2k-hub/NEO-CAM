const video=document.getElementById('preview'), statusText=document.getElementById('statusText'), effectName=document.getElementById('effectName');
const intensity=document.getElementById('intensity'), intensityValue=document.getElementById('intensityValue'), zoom=document.getElementById('zoom'), zoomValue=document.getElementById('zoomValue');
const recordBtn=document.getElementById('record'), downloadBtn=document.getElementById('download'), muteBtn=document.getElementById('mute'), switchBtn=document.getElementById('switchCam');
const cameraNote=document.getElementById('cameraNote'), micLevel=document.getElementById('micLevel'), audioState=document.getElementById('audioState'), recordTimer=document.getElementById('recordTimer');
let facing='user',stream=null,audioCtx=null,source=null,destination=null,recorder=null,chunks=[],current='normal',muted=false,recordedUrl=null,analyser=null,inputAnalyser=null,raf=0,hardwareZoom=false,zoomValueNum=1;
let processedAudioTrack=null;
let recordingAudioMode='';
let recordingStartedAt=0,timerRAF=0;
const filters={normal:{low:20,high:20000,distortion:0,dry:1,effect:0.0},robot:{low:220,high:5200,distortion:4,dry:.58,effect:.42},demon:{low:55,high:5200,distortion:3,dry:.62,effect:.38},radio:{low:280,high:3600,distortion:5,dry:.55,effect:.45},glitch:{low:140,high:7200,distortion:8,dry:.48,effect:.52}};
function curve(amount){const n=44100,c=new Float32Array(n),k=amount/100;for(let i=0;i<n;i++){const x=i*2/n-1;c[i]=(1+k)*x/(1+k*Math.abs(x));}return c}
function updateZoomUI(){zoomValue.textContent=zoomValueNum.toFixed(1)+'×';cameraNote.textContent=(hardwareZoom?'ZOOM CÁMARA':'ZOOM DIGITAL')+' · '+zoomValueNum.toFixed(1)+'×'}
async function applyZoom(){const track=stream?.getVideoTracks()[0];if(!track)return;const caps=track.getCapabilities?.()||{};hardwareZoom=!!caps.zoom;if(hardwareZoom){const min=caps.zoom.min??1,max=Math.min(caps.zoom.max??4,4);zoom.min=min;zoom.max=max;zoomValueNum=Math.max(min,Math.min(max,Number(zoom.value)));try{await track.applyConstraints({advanced:[{zoom:zoomValueNum}]})}catch{hardwareZoom=false}}if(!hardwareZoom)video.style.transform=`scale(${Math.max(1,zoomValueNum)})`;else video.style.transform='scale(1)';updateZoomUI()}
async function setupAudio(s){
  if(audioCtx){try{await audioCtx.close()}catch(e){}}
  const AC=window.AudioContext||window.webkitAudioContext;
  if(!AC) throw new Error('Web Audio no disponible');
  audioCtx=new AC({latencyHint:'interactive'});
  source=audioCtx.createMediaStreamSource(s);
  destination=audioCtx.createMediaStreamDestination();
  const gain=audioCtx.createGain();
  const low=audioCtx.createBiquadFilter();
  const high=audioCtx.createBiquadFilter();
  const dist=audioCtx.createWaveShaper();
  const comp=audioCtx.createDynamicsCompressor();
  const dry=audioCtx.createGain();
  const wet=audioCtx.createGain();
  inputAnalyser=audioCtx.createAnalyser();
  analyser=audioCtx.createAnalyser();
  inputAnalyser.fftSize=1024;
  analyser.fftSize=1024;
  source.connect(inputAnalyser);
  source.connect(gain);
  gain.connect(low);
  low.connect(high);
  high.connect(dist);
  dist.connect(comp);
  comp.connect(wet);
  wet.connect(destination);
  source.connect(dry);
  dry.connect(destination);
  comp.connect(analyser);
  processedAudioTrack=destination.stream.getAudioTracks()[0]||null;
  window.audioNodes={gain,low,high,dist,comp,dry,wet};
  if(audioCtx.state!=='running'){try{await audioCtx.resume()}catch(e){}}
  if(processedAudioTrack) processedAudioTrack.enabled=true;
  applyEffect();
  monitorMic();
}
function rmsFrom(an){
  if(!an)return 0;
  const data=new Uint8Array(an.fftSize);
  an.getByteTimeDomainData(data);
  let sum=0;
  for(const v of data){const x=(v-128)/128;sum+=x*x}
  return Math.sqrt(sum/data.length);
}
function monitorMic(){
  cancelAnimationFrame(raf);
  const tick=()=>{
    const input=rmsFrom(inputAnalyser);
    const processed=rmsFrom(analyser);
    const pct=Math.min(100,Math.round(input*500));
    micLevel.style.width=pct+'%';
    audioState.textContent=input>0.006?'MIC OK':'ESPERANDO MIC';
    audioState.style.color=input>0.006?'#55ff9a':'#ffb347';
    audioState.title='Entrada '+input.toFixed(4)+' · Procesado '+processed.toFixed(4);
    raf=requestAnimationFrame(tick);
  };
  tick();
}
async function waitForAudioSignal(an,ms=350){
  const until=performance.now()+ms;
  let peak=0;
  while(performance.now()<until){
    peak=Math.max(peak,rmsFrom(an));
    if(peak>0.006)return peak;
    await new Promise(r=>setTimeout(r,40));
  }
  return peak;
}
async function startCamera(){
  if(stream)stream.getTracks().forEach(t=>t.stop());
  stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:facing,width:{ideal:1080},height:{ideal:1920}},audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
  video.srcObject=stream;
  await video.play();
  zoomValueNum=1;zoom.value=1;video.style.transform='scale(1)';
  await setupAudio(stream);
  await applyZoom();
  statusText.textContent='CÁMARA LISTA';
}
document.querySelectorAll('.effect').forEach(btn=>btn.onclick=()=>{document.querySelectorAll('.effect').forEach(x=>x.classList.remove('active'));btn.classList.add('active');current=btn.dataset.effect;applyEffect()});
intensity.oninput=()=>{intensityValue.textContent=intensity.value+'%';applyEffect()};
zoom.oninput=async()=>{zoomValueNum=Number(zoom.value);await applyZoom()};
function formatTime(ms){const total=Math.max(0,Math.floor(ms/1000));const m=String(Math.floor(total/60)).padStart(2,'0');const sec=String(total%60).padStart(2,'0');return m+':'+sec}
function startTimer(){recordingStartedAt=performance.now();recordTimer.classList.add('live');cancelAnimationFrame(timerRAF);const tick=()=>{recordTimer.textContent=formatTime(performance.now()-recordingStartedAt);if(recorder?.state==='recording')timerRAF=requestAnimationFrame(tick)};tick()}
function stopTimer(){cancelAnimationFrame(timerRAF);recordTimer.classList.remove('live');recordTimer.textContent='00:00'}
recordBtn.onclick=async()=>{
  if(recorder&&recorder.state==='recording'){recorder.stop();return}
  if(!stream)return;
  try{
    if(!audioCtx || audioCtx.state!=='running'){
      if(!audioCtx) await setupAudio(stream);
      if(audioCtx.state!=='running') await audioCtx.resume();
    }
    const originalTrack=stream.getAudioTracks()[0]||null;
    if(originalTrack) originalTrack.enabled=true;
    const processedTrack=processedAudioTrack || destination?.stream.getAudioTracks()[0] || null;
    if(!originalTrack && !processedTrack){statusText.textContent='SIN MICRÓFONO';return}

    // Importante: una pista Web Audio puede aparecer como "live" aunque esté silenciosa.
    // Esperamos una señal real y solo usamos el audio procesado si hay señal.
    statusText.textContent='PROBANDO MIC...';
    const inputLevel=await waitForAudioSignal(inputAnalyser,500);
    const processedLevel=await waitForAudioSignal(analyser,250);
    let audioTrack=originalTrack;
    recordingAudioMode='MICRÓFONO DIRECTO';
    if(current!=='normal' && processedTrack && processedLevel>0.006){
      audioTrack=processedTrack;
      recordingAudioMode='VOZ PROCESADA';
    }
    if(!audioTrack){statusText.textContent='NO HAY AUDIO';return}

    chunks=[];
    const combined=new MediaStream([stream.getVideoTracks()[0],audioTrack]);
    let mime='video/webm;codecs=vp8,opus';
    if(MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus'))mime='video/webm;codecs=vp9,opus';
    else if(!MediaRecorder.isTypeSupported(mime)&&MediaRecorder.isTypeSupported('video/webm'))mime='video/webm';
    recorder=new MediaRecorder(combined,{mimeType:mime,audioBitsPerSecond:128000,videoBitsPerSecond:5000000});
    recorder.ondataavailable=e=>{if(e.data&&e.data.size)chunks.push(e.data)};
    recorder.onerror=e=>{console.error(e);recordBtn.classList.remove('recording');stopTimer();statusText.textContent='ERROR DE GRABACIÓN'};
    recorder.onstop=()=>{
      recordBtn.classList.remove('recording');
      stopTimer();
      const blob=new Blob(chunks,{type:recorder.mimeType||'video/webm'});
      if(recordedUrl)URL.revokeObjectURL(recordedUrl);
      recordedUrl=URL.createObjectURL(blob);
      downloadBtn.disabled=false;
      downloadBtn.onclick=()=>{const a=document.createElement('a');a.href=recordedUrl;a.download='neo-cam-'+Date.now()+'.webm';document.body.appendChild(a);a.click();a.remove()};
      statusText.textContent='VIDEO LISTO · '+recordingAudioMode;
    };
    recorder.start(250);
    recordBtn.classList.add('recording');
    statusText.textContent='GRABANDO · '+recordingAudioMode;
    startTimer();
  }catch(e){console.error(e);recordBtn.classList.remove('recording');stopTimer();statusText.textContent='NO SE PUDO GRABAR'}
};
muteBtn.onclick=()=>{muted=!muted;muteBtn.textContent=muted?'🔇':'🎙️';applyEffect()};
switchBtn.onclick=async()=>{facing=facing==='user'?'environment':'user';try{await startCamera()}catch(e){console.error(e);statusText.textContent='NO SE PUDO CAMBIAR'}};
(async()=>{try{await startCamera()}catch(e){console.error(e);statusText.textContent='PERMISO DE CÁMARA REQUERIDO'}})();
