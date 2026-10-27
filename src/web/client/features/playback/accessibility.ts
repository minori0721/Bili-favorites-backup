import type Artplayer from 'artplayer';

/** Keyboard semantics for the pinned player's existing controls; no second player state. */
export function bindPlaybackAccessibility(art:Artplayer) {
  const player=art.template.$player;
  const document=player.ownerDocument;
  const listeners=new AbortController();
  const buttons=[
    ['.art-control-playAndPause','播放'],['.art-control-setting','播放设置'],
    ['.art-control-pip','画中画'],['.art-control-fullscreenWeb','网页全屏'],['.art-control-fullscreen','全屏'],
  ];
  for(const [selector,label] of buttons){
    const control=player.querySelector<HTMLElement>(selector);
    if(control){control.tabIndex=0;control.setAttribute('role','button');control.setAttribute('aria-label',label);}
  }
  const progress=player.querySelector<HTMLElement>('.art-control-progress');
  const volume=player.querySelector<HTMLElement>('.art-control-volume');
  for(const [control,label] of [[progress,'播放进度'],[volume,'音量']] as const){
    if(control){control.tabIndex=0;control.setAttribute('role','slider');control.setAttribute('aria-label',label);control.setAttribute('aria-valuemin','0');}
  }
  function update(){
    const duration=Number.isFinite(art.duration)?art.duration:0;
    progress?.setAttribute('aria-valuemax',String(duration));
    progress?.setAttribute('aria-valuenow',String(Math.min(duration,Math.max(0,art.currentTime||0))));
    if(progress)progress.tabIndex=duration>0?0:-1;
    volume?.setAttribute('aria-valuemax','100');
    volume?.setAttribute('aria-valuenow',String(Math.round(art.muted?0:art.volume*100)));
    player.querySelector('.art-control-playAndPause')?.setAttribute('aria-label',art.video.paused?'播放':'暂停');
    player.querySelector('.art-control-setting')?.setAttribute('aria-expanded',String(art.setting.show));
    art.template.$setting.setAttribute('aria-hidden',String(!art.setting.show));
    art.template.$setting.querySelectorAll<HTMLElement>('.art-setting-item').forEach(item=>{
      item.tabIndex=0;item.setAttribute('role','button');item.setAttribute('aria-label',item.textContent?.trim()||'播放设置');
    });
  }
  const observer=new MutationObserver(update);
  observer.observe(art.template.$setting,{childList:true,subtree:true});
  player.addEventListener('focusin',()=>{art.controls.show=true;},{signal:listeners.signal});
  player.addEventListener('keydown',event=>{
    if(event.altKey||event.ctrlKey||event.metaKey)return;
    const target=event.target instanceof Element?event.target.closest<HTMLElement>('[role=button],[role=slider]'):null;
    if(!target||!player.contains(target))return;
    const arrow=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key);
    if(target===progress&&arrow){
      event.preventDefault();event.stopPropagation();
      if(art.duration>0)art.currentTime=event.key==='Home'?0:event.key==='End'?art.duration:Math.min(art.duration,Math.max(0,art.currentTime+(['ArrowLeft','ArrowDown'].includes(event.key)?-5:5)));
      update();return;
    }
    if(target===volume&&(arrow||event.key===' '||event.key==='Enter')){
      event.preventDefault();event.stopPropagation();
      if(arrow){art.muted=false;art.volume=event.key==='Home'?0:event.key==='End'?1:Math.min(1,Math.max(0,art.volume+(['ArrowLeft','ArrowDown'].includes(event.key)?-.1:.1)));}
      else art.muted=!art.muted;
      update();return;
    }
    if(event.key==='Escape'&&art.setting.show){
      event.preventDefault();event.stopPropagation();art.setting.show=false;update();player.querySelector<HTMLElement>('.art-control-setting')?.focus();return;
    }
    if(target.getAttribute('role')==='button'&&(event.key==='Enter'||event.key===' ')){
      event.preventDefault();event.stopPropagation();
      // This vendor control binds clicks to its two icons, not the outer div.
      if(target.matches('.art-control-playAndPause'))art.toggle();
      else target.click();
      if(art.setting.show)queueMicrotask(()=>{if(!art.isDestroy)art.template.$setting.querySelector<HTMLElement>('.art-setting-item')?.focus();});
    }
  },{signal:listeners.signal});
  for(const event of ['video:play','video:pause','video:timeupdate','video:volumechange','video:loadedmetadata','setting'])art.on(event,update);
  art.once('destroy',()=>{listeners.abort();observer.disconnect();});
  update();
}
