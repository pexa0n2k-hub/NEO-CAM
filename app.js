const $=id=>document.getElementById(id);
const video=$('preview'),statusText=$('statusText'),effectName=$('effectName');
const intensity=$('intensity'),intensityValue=$('intensityValue'),zoom=$('zoom'),zoomValue=$('zoomValue');
const recordBtn=$('record'),downloadBtn=$('download'),muteBtn=$('mute'),switchBtn=$('switchCam');
const cameraNote=$('cameraNote'),micLevel=$('micLevel'),audioState=$('audioState'),recordTimer=$('recordTimer');
let facing='user',stream=null,audioCtx=null,source=null,destination=null,recorder=null,chunks=[];
let current='normal',muted=false,recordedUrl=null,inputAnalyser=null,raf=0,timerId=0,startedAt=0;
let nodes=null,hardwareZoom=false,zoomValueNum=1,recordingAudioMode='';
const effects={normal:{low:20,high:20000,dist:0,wet:0},robot:{low:100,high:6500,dist:22,wet:.82},demon:{low:55,high:6500,dist:16,wet:.78},radio:{low:280,high:3600,dist:10,wet:.82},glitch:{low:90,high:8500,dist:30,wet:.88}};
function curve(amount){const n=44100,c=new Float32Array(n),k=Math.max(0,amount)/100*12;for(let i=0;i<n;i++){const x=i*2/n-1;c[i]=(1+k)*x/(1+k*Math.abs(x));}return c}
function applyEffect(){
 if(!nodes)return;
 const e=effects[current],p=Number(intensity.value)/100;
 nodes.low.frequency.value=e.low; nodes.high.frequency.value=e.high;
 nodes.dist.curve=curve(e.dist*p); nodes.dist.oversample='4x';
 nodes.dry.gain.value=muted?0:(current==='normal'?1:Math.max(.22,1-e.wet*.65*p));
 nodes.wet.gain.value=muted?0:(current==='normal'?0:Math.min(.92,e.wet*p));
 nodes.delay.delayTime.value=current==='radio'?.035:current==='glitch'?.012:current==='demon'?.008:0;
 nodes.feedback.gain.value=current==='radio'?.18:current==='glitch'?.28:0;
 nodes.modDepth.gain.value=current==='robot'?Math.min(.8,.18+.58*p):current==='glitch'?Math.min(.35,.05+.25*p):0;
 nodes.mod.frequency.value=current==='robot'?42:current==='glitch'?18:0;
 nodes.wetFilter.frequency.value=current==='radio'?3600:current==='robot'?6200:current==='demon'?5200:current==='glitch'?7800:20000;
 effectName.textContent=current.toUpperCase();
}
function rms(an){if(!an)return 0;const d=new Uint8Array(an.fftSize);an.getByteTimeDomainData(d);let s=0;for(const v of d){const x=(v-128)/128;s+=x*x}return Math.sqrt(s/d.length)}
function monitorMic(){cancelAnimationFrame(raf);const tick=()=>{const r=rms(inputAnalyser),p=Math.min(100,Math.round(r*700));micLevel.style.width=p+'%';audioState.textContent=r>.005?'MIC OK':'ESPERANDO MIC';audioState.style.color=r>.005?'#55ff9a':'#ffb347';raf=requestAnimationFrame(tick)};tick()}
function formatTime(ms){let s=Math.floor(ms/1000);return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
function startTimer(){startedAt=performance.now();recordTimer.classList.add('live');cancelAnimationFrame(timerId);const tick=()=>{recordTimer.textContent=formatTime(performance.now()-startedAt);if(recorder?.state==='recording')timerId=requestAnimationFrame(tick)};tick()}
function stopTimer(){cancelAnimationFrame(timerId);recordTimer.classList.remove('live');recordTimer.textContent='00:00'}
function setStatus(t){statusText.textContent=t}
async function setupAudio(s){
 const AC=window.AudioContext||window.webkitAudioContext;if(!AC)throw Error('Web Audio no disponible');
 if(audioCtx){try{await audioCtx.close()}catch{}}
 audioCtx=new AC({latencyHint:'interactive'});
 source=audioCtx.createMediaStreamSource(s); destination=audioCtx.createMediaStreamDestination();
 const input=audioCtx.createGain(),low=audioCtx.createBiquadFilter(),high=audioCtx.createBiquadFilter();
 const dist=audioCtx.createWaveShaper(),dry=audioCtx.createGain(),wet=audioCtx.createGain();
 const delay=audioCtx.createDelay(.5),feedback=audioCtx.createGain(),wetFilter=audioCtx.createBiquadFilter();
 const mod=audioCtx.createOscillator(),modDepth=audioCtx.createGain(),modCarrier=audioCtx.createGain();
 low.type='lowpass'; high.type='highpass'; wetFilter.type='lowpass';
 inputAnalyser=audioCtx.createAnalyser();inputAnalyser.fftSize=1024;
 source.connect(inputAnalyser);source.connect(input);
 input.connect(low);low.connect(high);high.connect(dist);
 // Clean branch is always available; processed branch gets filters + modulation/delay.
 dist.connect(wetFilter);wetFilter.connect(delay);delay.connect(wet);delay.connect(feedback);feedback.connect(delay);feedback.gain.value=0;
 dist.connect(dry);
 // Ring modulation for ROBOT/GLITCH. Oscillator never goes to speakers directly.
 mod.frequency.value=0;modDepth.gain.value=0;mod.connect(modDepth);modDepth.connect(modCarrier.gain);dist.connect(modCarrier);modCarrier.gain.value=1;
 mod.start();
 dry.connect(destination);wet.connect(destination);
 nodes={input,low,high,dist,dry,wet,delay,feedback,wetFilter,mod,modDepth,modCarrier};
 await audioCtx.resume();
 const track=destination.stream.getAudioTracks()[0];if(track)track.enabled=true;
 applyEffect();monitorMic();
}
async function startCamera(){
 if(stream)stream.getTracks().forEach(t=>t.stop());
 stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:facing,width:{ideal:1920},height:{ideal:1080}},audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
 video.srcObject=stream;await video.play();zoomValueNum=1;zoom.value=1;zoomValue.textContent='1.0×';video.style.transform='scale(1)';await setupAudio(stream);await applyZoom();setStatus('CÁMARA LISTA')
}
async function applyZoom(){const track=stream?.getVideoTracks()[0];if(!track)return;const caps=track.getCapabilities?.()||{};hardwareZoom=typeof caps.zoom==='object';if(hardwareZoom){zoom.min=caps.zoom.min??1;zoom.max=Math.min(caps.zoom.max??4,4);try{await track.applyConstraints({advanced:[{zoom:zoomValueNum}]});video.style.transform='scale(1)'}catch{hardwareZoom=false}}if(!hardwareZoom)video.style.transform=`scale(${Math.max(1,zoomValueNum)})`;zoomValue.textContent=zoomValueNum.toFixed(1)+'×';cameraNote.textContent=(hardwareZoom?'ZOOM CÁMARA':'ZOOM DIGITAL')+' · '+zoomValueNum.toFixed(1)+'×'}
document.querySelectorAll('.effect').forEach(b=>b.onclick=()=>{document.querySelectorAll('.effect').forEach(x=>x.classList.remove('active'));b.classList.add('active');current=b.dataset.effect;applyEffect()});
intensity.oninput=()=>{intensityValue.textContent=intensity.value+'%';applyEffect()};zoom.oninput=async()=>{zoomValueNum=Number(zoom.value);await applyZoom()};muteBtn.onclick=()=>{muted=!muted;muteBtn.textContent=muted?'🔇':'🎙️';applyEffect()};
switchBtn.onclick=async()=>{facing=facing==='user'?'environment':'user';try{await startCamera()}catch(e){console.error(e);setStatus('NO SE PUDO CAMBIAR')}};
recordBtn.onclick=async()=>{if(recorder?.state==='recording'){recorder.stop();return}try{
 if(!audioCtx)await setupAudio(stream);if(audioCtx.state!=='running')await audioCtx.resume();
 // Give the graph a moment to wake up on Android before MediaRecorder starts.
 await new Promise(r=>setTimeout(r,120));
 const vt=stream?.getVideoTracks()[0],at=destination?.stream.getAudioTracks()[0];if(!vt||!at)throw Error('No hay pistas de video/audio');at.enabled=!muted;chunks=[];
 const combined=new MediaStream([vt,at]);const types=['video/webm;codecs=vp8,opus','video/webm;codecs=vp9,opus','video/webm'];const mime=types.find(t=>MediaRecorder.isTypeSupported(t))||'';
 recorder=new MediaRecorder(combined,mime?{mimeType:mime,audioBitsPerSecond:128000,videoBitsPerSecond:5000000}:undefined);
 recordingAudioMode=current==='normal'?'MICRÓFONO':'FILTRO '+current.toUpperCase();
 recorder.ondataavailable=e=>{if(e.data?.size)chunks.push(e.data)};
 recorder.onerror=e=>{console.error(e);recordBtn.classList.remove('recording');stopTimer();setStatus('ERROR DE GRABACIÓN')};
 recorder.onstop=()=>{recordBtn.classList.remove('recording');stopTimer();const blob=new Blob(chunks,{type:recorder.mimeType||'video/webm'});if(recordedUrl)URL.revokeObjectURL(recordedUrl);recordedUrl=URL.createObjectURL(blob);downloadBtn.disabled=false;downloadBtn.onclick=()=>{const a=document.createElement('a');a.href=recordedUrl;a.download='neo-cam-'+Date.now()+'.webm';a.click()};setStatus('VIDEO LISTO · '+recordingAudioMode)};
 recorder.start(250);recordBtn.classList.add('recording');setStatus('GRABANDO · '+recordingAudioMode);startTimer();
 }catch(e){console.error(e);recordBtn.classList.remove('recording');stopTimer();setStatus('NO SE PUDO GRABAR')}};
recordTimer.textContent='00:00';
(async()=>{try{await startCamera()}catch(e){console.error(e);setStatus('PERMISO DE CÁMARA REQUERIDO')}})();
