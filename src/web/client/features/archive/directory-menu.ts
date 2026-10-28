export interface DirectoryAction {label:string;run?:()=>void;href?:string;danger?:boolean}

/** One portal menu per library, with listeners owned by the currently open menu. */
export function createDirectoryMenu(document:Document) {
  let current:{element:HTMLElement;owner:HTMLButtonElement;events:AbortController}|null=null;
  function close(restoreFocus=false){
    if(!current)return;
    const {element,owner,events}=current;current=null;
    events.abort();element.remove();owner.setAttribute('aria-expanded','false');
    if(restoreFocus&&owner.isConnected)owner.focus({preventScroll:true});
  }
  function open(owner:HTMLButtonElement,title:string,actions:DirectoryAction[]){
    if(current?.owner===owner){close(true);return;}
    close();
    const element=document.createElement('div');element.className='archive-source-menu';
    element.setAttribute('role','menu');element.setAttribute('aria-label',title+'的更多操作');
    const events=new AbortController();current={element,owner,events};
    owner.setAttribute('aria-expanded','true');
    for(const action of actions){
      const item=document.createElement(action.href?'a':'button');item.textContent=action.label;item.setAttribute('role','menuitem');
      if(item instanceof HTMLAnchorElement&&action.href){item.href=action.href;item.target='_blank';item.rel='noopener noreferrer';}
      if(item instanceof HTMLButtonElement)item.type='button';
      if(action.danger)item.classList.add('danger');
      item.addEventListener('click',()=>{close();action.run?.();},{signal:events.signal});element.append(item);
    }
    // Keep focus inside its dialog so the existing focus trap and delayed focus agree.
    (owner.closest('[role="dialog"]')||document.body).append(element);
    const rect=owner.getBoundingClientRect();const bounds=element.getBoundingClientRect();const view=document.defaultView!;
    element.style.left=Math.max(8,Math.min(view.innerWidth-bounds.width-8,rect.right-bounds.width))+'px';
    element.style.top=Math.max(8,Math.min(view.innerHeight-bounds.height-8,rect.bottom+6))+'px';
    document.addEventListener('pointerdown',event=>{if(event.target instanceof Node&&!element.contains(event.target)&&!owner.contains(event.target))close();},{signal:events.signal});
    document.addEventListener('scroll',event=>{
      if(!(event.target instanceof Node)||element.contains(event.target))return;
      const position=owner.getBoundingClientRect();
      if(position.top!==rect.top||position.left!==rect.left)close();
    },{capture:true,signal:events.signal});
    view.addEventListener('resize',()=>close(),{signal:events.signal});
    element.addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);return;}
      if(event.key==='Tab'){close(true);return;}
      if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
      event.preventDefault();event.stopPropagation();
      const items=Array.from(element.querySelectorAll<HTMLElement>('[role=menuitem]'));
      const index=items.findIndex(item=>item===document.activeElement);
      const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
      items[next]?.focus();
    },{signal:events.signal});
    element.querySelector<HTMLElement>('[role=menuitem]')?.focus({preventScroll:true});
  }
  return {open,close};
}

export function directoryIcon(document:Document,kind:'folder'|'account'|'global'|'up'){
  const image=document.createElementNS('http://www.w3.org/2000/svg','svg');image.setAttribute('viewBox','0 0 24 24');image.setAttribute('aria-hidden','true');
  const paths=kind==='global'?['M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z']:
    kind==='account'||kind==='up'?['M5 21v-2a7 7 0 0 1 14 0v2','M15.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0']:
    ['M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'];
  for(const value of paths){const shape=document.createElementNS(image.namespaceURI,'path');shape.setAttribute('d',value);image.append(shape);}
  return image;
}
