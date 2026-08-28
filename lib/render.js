"use strict";

const fs=require("fs");
const path=require("path");
const {ffmpeg,probeDuration,motionFilter,fitFilter,manualCrop,transitionSpec,outputSize}=require("./ffmpeg");
const MIN_DUR=0.1;

function compressionArgs(meta={}, size){
  const crf=Number(meta.crf)||20;
  const preset=meta.preset||"veryfast";
  const ab=meta.audioBitrate||"160k";
  return ["-c:v","libx264","-preset",String(preset),"-crf",String(crf),"-pix_fmt","yuv420p","-profile:v","high","-movflags","+faststart","-c:a","aac","-b:a",String(ab),"-ar","48000","-ac","2","-threads",String(Number(process.env.FFMPEG_THREADS)||2)];
}

async function renderPanelClip(panel,opts){
  const {fps,outDir,index,extraTail,fit,log}=opts;
  const size=opts.size||outputSize(panel);
  let dur=Number(panel.duration)||0;
  if(panel.audioPath&&fs.existsSync(panel.audioPath)){const d=await probeDuration(panel.audioPath);if(d)dur=d;}
  if(!Number.isFinite(dur)||dur<=0)dur=4;
  dur=Math.max(MIN_DUR,dur);
  const clipDur=dur+Math.max(0,Number(extraTail)||0);

  // IMPORTANT: motion zoompan must receive ONE image frame, not a full FPS stream.
  // Feeding an FPS stream into zoompan with d=frameCount multiplies the work massively.
  const motion=String(panel.motion||"Static");
  const isStatic=["static","none",""].includes(String(motion).trim().toLowerCase());
  const args=isStatic
    ? ["-loop","1","-framerate",String(fps),"-t",String(clipDur),"-i",panel.imagePath]
    : ["-loop","1","-framerate","1","-t","1","-i",panel.imagePath];

  const hasAudio=panel.audioPath&&fs.existsSync(panel.audioPath);
  if(hasAudio)args.push("-i",panel.audioPath);
  const vfxList=(panel.vfx||[]).filter(v=>v&&v.file&&fs.existsSync(v.file));
  const sfxList=(panel.sfx||[]).filter(v=>v&&v.file&&fs.existsSync(v.file));
  let inputIndex=1+(hasAudio?1:0),vfxIdx=[],sfxIdx=[];
  for(const v of vfxList){args.push("-stream_loop","-1","-t",String(clipDur),"-i",v.file);vfxIdx.push(inputIndex++);}
  for(const s of sfxList){if(s.loop)args.push("-stream_loop","-1");args.push("-t",String(clipDur),"-i",s.file);sfxIdx.push(inputIndex++);}

  const chain=[];
  const crop=manualCrop(panel.zoom,panel.cropX,panel.cropY);
  let pre=crop?`${crop},${fitFilter(fit,size)}`:fitFilter(fit,size);
  if(!isStatic) chain.push(`[0:v]${motionFilter(motion,clipDur,fps,size)},format=yuv420p,trim=duration=${clipDur},setpts=PTS-STARTPTS[base]`);
  else chain.push(`[0:v]${pre},trim=duration=${clipDur},setpts=PTS-STARTPTS[base]`);
  let vLabel="base";
  vfxIdx.forEach((idx,i)=>{
    const op=Math.max(0,Math.min(1,Number(vfxList[i].opacity??0.6)));
    chain.push(`[${idx}:v]scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba,colorchannelmixer=aa=${op.toFixed(3)},fps=${fps},trim=duration=${clipDur},setpts=PTS-STARTPTS[vfx${i}]`);
    const out=`vout${i}`;chain.push(`[${vLabel}][vfx${i}]overlay=0:0:shortest=0:format=auto[${out}]`);vLabel=out;
  });
  chain.push(`[${vLabel}]format=yuv420p[vfinal]`);

  const aParts=[];
  if(hasAudio){chain.push(`[1:a]aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:${clipDur},asetpts=PTS-STARTPTS[nar]`);aParts.push("nar");}
  sfxIdx.forEach((idx,i)=>{const vol=Math.max(0,Math.min(4,Number(sfxList[i].volume??0.08)));chain.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${vol.toFixed(3)},apad,atrim=0:${clipDur},asetpts=PTS-STARTPTS[sfx${i}]`);aParts.push(`sfx${i}`);});
  if(!aParts.length){args.push("-f","lavfi","-t",String(clipDur),"-i","anullsrc=channel_layout=stereo:sample_rate=48000");chain.push(`[${inputIndex}:a]atrim=0:${clipDur},asetpts=PTS-STARTPTS[afinal]`);} else if(aParts.length===1){chain.push(`[${aParts[0]}]anull[afinal]`);} else chain.push(`${aParts.map(x=>`[${x}]`).join("")}amix=inputs=${aParts.length}:duration=longest:dropout_transition=0:normalize=0[afinal]`);

  const out=path.join(outDir,`clip_${String(index).padStart(4,"0")}.mp4`);
  args.push("-filter_complex",chain.join(";"),"-map","[vfinal]","-map","[afinal]","-r",String(fps),"-t",String(clipDur),"-c:v","libx264","-preset",String(process.env.FFMPEG_PRESET||"veryfast"),"-crf",String(process.env.FFMPEG_CRF||20),"-pix_fmt","yuv420p","-c:a","aac","-b:a","160k","-ar","48000","-ac","2",out);
  await ffmpeg(args,{onLog:log});
  return {file:out,duration:clipDur,contentDuration:dur};
}

async function concatClips(clips,transitions,finalPath,meta={},fps,log){
  if(clips.length===1){await ffmpeg(["-i",clips[0].file,...compressionArgs(meta),finalPath],{onLog:log});return finalPath;}
  const useXfade=transitions.some(Boolean);
  if(!useXfade){
    const listFile=finalPath+".txt";fs.writeFileSync(listFile,clips.map(c=>`file '${c.file.replace(/'/g,"'\\''")}'`).join("\n"));
    try{await ffmpeg(["-f","concat","-safe","0","-i",listFile,"-c","copy","-movflags","+faststart",finalPath],{onLog:log});}
    finally{try{fs.unlinkSync(listFile);}catch{}}
    return finalPath;
  }

  // xfade is expensive for hundreds of inputs. Split only at an actual
  // hard-cut boundary so no requested visual transition is lost.
  const CHUNK=Number(process.env.XFADE_CHUNK_SIZE)||30;
  if(clips.length>CHUNK){
    const ranges=[];
    let start=0;
    while(start<clips.length){
      let end=Math.min(clips.length,start+CHUNK);
      if(end<clips.length){
        // Move the boundary backwards to the nearest hard cut.
        while(end>start+1 && transitions[end-1]) end--;
        // If there is no hard cut in the window, keep the graph intact rather
        // than silently changing a requested transition.
        if(end===start+1) end=Math.min(clips.length,start+CHUNK);
      }
      ranges.push([start,end]);
      start=end;
    }
    // If the only possible split is a non-hard transition, fail clearly
    // instead of producing a video with an incorrect transition.
    for(let i=0;i<ranges.length-1;i++){
      const boundary=ranges[i][1]-1;
      if(transitions[boundary]){
        throw new Error(`Cannot safely chunk xfade at transition ${boundary+1}; use a smaller hard-cut boundary or increase XFADE_CHUNK_SIZE.`);
      }
    }
    const parts=[];
    for(let r=0;r<ranges.length;r++){
      const [a,b]=ranges[r];
      const sub=clips.slice(a,b);
      const subTrans=transitions.slice(a,b-1);
      const part=path.join(path.dirname(finalPath),`chunk_${String(a).padStart(4,"0")}.mp4`);
      await concatClips(sub,subTrans,part,meta,fps,log); parts.push(part);
    }
    const list=finalPath+".chunks.txt";
    fs.writeFileSync(list,parts.map(c=>`file '${c.replace(/'/g,"'\\''")}'`).join("\n"));
    try{await ffmpeg(["-f","concat","-safe","0","-i",list,"-c","copy","-movflags","+faststart",finalPath],{onLog:log});}
    finally{try{fs.unlinkSync(list);}catch{}}
    for(const p of parts){try{fs.unlinkSync(p);}catch{}}
    return finalPath;
  }

  const args=[];clips.forEach(c=>args.push("-i",c.file));
  const chain=[];let vPrev="0:v",aPrev="0:a",offset=clips[0].duration;
  for(let i=1;i<clips.length;i++){
    const spec=transitions[i-1],d=spec?Math.min(spec.duration,Math.max(0.01,clips[i-1].duration/2,clips[i].duration/2)):0;
    if(spec){
      const vo=`v${i}`,ao=`a${i}`,off=Math.max(0,offset-d);
      const vp=`vp${i}`,vn=`vn${i}`;
      // xfade requires identical timebases. concat/MP4 inputs may otherwise differ.
      chain.push(`[${vPrev}]settb=AVTB[${vp}]`);
      chain.push(`[${i}:v]settb=AVTB[${vn}]`);
      chain.push(`[${vp}][${vn}]xfade=transition=${spec.name}:duration=${d}:offset=${off.toFixed(3)},settb=AVTB[${vo}]`);
      chain.push(`[${aPrev}][${i}:a]acrossfade=d=${d}:c1=tri:c2=tri[${ao}]`);
      vPrev=vo;aPrev=ao;offset=off+clips[i].duration;
    } else {
      const vo=`v${i}`,ao=`a${i}`;
      chain.push(`[${vPrev}][${i}:v]concat=n=2:v=1:a=0[${vo}]`);
      chain.push(`[${aPrev}][${i}:a]concat=n=2:v=0:a=1[${ao}]`);
      vPrev=vo;aPrev=ao;offset+=clips[i].duration;
    }
  }
  args.push("-filter_complex",chain.join(";"),"-map",`[${vPrev}]`,"-map",`[${aPrev}]`,`-r`,String(fps),...compressionArgs(meta),finalPath);
  await ffmpeg(args,{onLog:log});return finalPath;
}

async function applyOverlayLogo(input,overlayFile,overlay,output,meta,log){
  // Use requested output dimensions when available; otherwise 1280x720.
  const size=outputSize(meta),sizePct=Math.max(1,Math.min(50,Number(overlay.sizePct)||12)),opacity=Math.max(0,Math.min(1,Number(overlay.opacity??0.8))),margin=Math.max(0,Number(overlay.marginPx)||24),pos=String(overlay.position||"bottom-right");
  const x=pos.includes("left")?`${margin}`:`W-w-${margin}`,y=pos.startsWith("top")?`${margin}`:`H-h-${margin}`,logoW=Math.round(size.width*sizePct/100);
  await ffmpeg(["-i",input,"-i",overlayFile,"-filter_complex",`[1:v]scale=${logoW}:-1,format=rgba,colorchannelmixer=aa=${opacity.toFixed(3)}[logo];[0:v][logo]overlay=${x}:${y}[v]`,"-map","[v]","-map","0:a?",...compressionArgs(meta,size),output],{onLog:log});return output;
}

async function normalizeAudio(input,output,meta,log){await ffmpeg(["-i",input,"-af","loudnorm=I=-16:TP=-1.5:LRA=11",...compressionArgs(meta),output],{onLog:log});return output;}
module.exports={renderPanelClip,concatClips,applyOverlayLogo,normalizeAudio,transitionSpec,compressionArgs};
