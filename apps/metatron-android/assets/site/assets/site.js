const menu=document.getElementById('site-menu');
const trigger=document.getElementById('menu-toggle');
trigger?.addEventListener('click',()=>{menu.showModal();trigger.setAttribute('aria-expanded','true');document.body.classList.add('menu-open');});
document.getElementById('menu-close')?.addEventListener('click',()=>menu.close());
menu?.addEventListener('close',()=>{trigger.setAttribute('aria-expanded','false');document.body.classList.remove('menu-open');trigger.focus();});
menu?.addEventListener('click',event=>{if(event.target===menu)menu.close();});
document.querySelectorAll('.capability-list button[aria-expanded]').forEach(button=>{button.addEventListener('click',()=>{const open=button.getAttribute('aria-expanded')==='true';button.setAttribute('aria-expanded',String(!open));const item=button.closest('article,li,.capability-item,.capability-row')||button.parentElement;item.classList.toggle('is-open',!open);const panel=button.getAttribute('aria-controls')?document.getElementById(button.getAttribute('aria-controls')):button.nextElementSibling;if(panel){panel.hidden=open;panel.style.display=open?'none':'block';}});});

// Progressive motion: content stays visible when JavaScript or motion support is absent.
const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
let revealObserver;
function setMotion(){
  if(reducedMotion.matches){document.documentElement.classList.remove('motion-ready');revealObserver?.disconnect();document.querySelectorAll('.reveal-pending').forEach(n=>n.classList.remove('reveal-pending'));return;}
  if(!('IntersectionObserver' in window))return;
  document.documentElement.classList.add('motion-ready');
  revealObserver=new IntersectionObserver(entries=>{entries.forEach(entry=>{if(entry.isIntersecting){entry.target.classList.remove('reveal-pending');entry.target.classList.add('reveal-visible');revealObserver.unobserve(entry.target);}});},{threshold:.06,rootMargin:'0px 0px -20px 0px'});
  document.querySelectorAll('main .section').forEach(section=>{section.classList.add('reveal-section');if(section.getBoundingClientRect().top>innerHeight){section.classList.add('reveal-pending');revealObserver.observe(section);}});
}
setMotion();reducedMotion.addEventListener('change',setMotion);
menu?.querySelectorAll('a').forEach(link=>link.addEventListener('click',()=>menu.close()));
document.querySelectorAll('nav a[href]').forEach(link=>{const url=new URL(link.href);if(url.origin===location.origin&&url.pathname===location.pathname&&!url.hash)link.setAttribute('aria-current','page');});
let framePending=false;
function updatePagePosition(){const total=document.documentElement.scrollHeight-innerHeight;document.documentElement.style.setProperty('--reading-progress',String(total>0?Math.min(1,scrollY/total):0));const anchors=[...document.querySelectorAll('.service-index a')];let active=null;anchors.forEach(a=>{const section=document.querySelector(a.getAttribute('href'));if(section&&section.getBoundingClientRect().top<innerHeight*.4)active=a;});anchors.forEach(a=>{if(a===active)a.setAttribute('aria-current','location');else a.removeAttribute('aria-current');});framePending=false;}
window.addEventListener('scroll',()=>{if(!framePending){framePending=true;requestAnimationFrame(updatePagePosition);}},{passive:true});window.addEventListener('resize',updatePagePosition);updatePagePosition();

document.querySelectorAll('[data-service-showcase]').forEach(showcase=>{const tabs=[...showcase.querySelectorAll('[role="tab"]')];const selectTab=tab=>{tabs.forEach(t=>{const selected=t===tab;t.setAttribute('aria-selected',String(selected));t.tabIndex=selected?0:-1;document.getElementById(t.getAttribute('aria-controls')).hidden=!selected;});};tabs.forEach((tab,index)=>{tab.addEventListener('click',()=>selectTab(tab));tab.addEventListener('keydown',event=>{let next=index;if(event.key==='ArrowRight')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();selectTab(tabs[next]);tabs[next].focus();});});});

const motionButton=document.createElement('button');motionButton.className='motion-toggle';motionButton.type='button';motionButton.setAttribute('aria-pressed','false');motionButton.textContent='Pause motion';document.querySelector('.footer-bottom')?.append(motionButton);motionButton.addEventListener('click',()=>{const paused=document.documentElement.classList.toggle('motion-paused');motionButton.setAttribute('aria-pressed',String(paused));motionButton.textContent=paused?'Enable motion':'Pause motion';});
