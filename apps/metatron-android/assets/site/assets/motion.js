// Extra motion layer: scroll progress, 3D card reveals and tilt, decoding eyebrows.
// Everything stays visible without JavaScript, and nothing runs under reduced motion.
(()=>{
const root=document.documentElement;
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
if(reduced.matches||!('IntersectionObserver' in window))return;
root.classList.add('mx');

// Scroll progress bar.
const bar=document.createElement('div');bar.className='mx-progress';bar.setAttribute('aria-hidden','true');document.body.append(bar);
let pending=false;
const progress=()=>{const total=root.scrollHeight-innerHeight;bar.style.transform=`scaleX(${total>0?Math.min(1,scrollY/total):0})`;pending=false;};
addEventListener('scroll',()=>{if(!pending){pending=true;requestAnimationFrame(progress);}},{passive:true});progress();

// Staggered reveals for card grids and lists.
const groups='.aether-hardware,.aether-arch,.aether-rollout,.metatron-ecosystem,.product-use-cases,.site-map-links,.veil-table tbody,.product-grid,.one-product-category';
const io=new IntersectionObserver(entries=>entries.forEach(e=>{if(!e.isIntersecting)return;const g=e.target;g.classList.add('mx-in');io.unobserve(g);setTimeout(()=>g.classList.add('mx-settled'),1800);}),{threshold:.12,rootMargin:'0px 0px -8% 0px'});
document.querySelectorAll(groups).forEach(g=>{
  // Only animate groups that start below the fold, so nothing on screen flickers at load.
  if(g.getBoundingClientRect().top<innerHeight)return;
  const items=g.matches('.one-product-category')?g.querySelectorAll('.one-product'):g.children;
  [...items].forEach((c,i)=>{c.classList.add('mx-item');c.style.setProperty('--mx-i',Math.min(i,10));});
  g.classList.add('mx-group');io.observe(g);
});

// 3D tilt: cards lean toward the pointer, with a light glare that follows it.
if(matchMedia('(hover: hover) and (pointer: fine)').matches){
  document.querySelectorAll('.aether-hardware>li,.aether-arch>li,.aether-rollout>li,.product-use-cases>div,.product-entry').forEach(card=>{
    card.classList.add('mx-tilt');
    let raf=0;
    card.addEventListener('pointermove',e=>{
      if(root.classList.contains('motion-paused'))return;
      const r=card.getBoundingClientRect();const x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
      cancelAnimationFrame(raf);raf=requestAnimationFrame(()=>{
        card.style.setProperty('--mx-rx',`${(.5-y)*10}deg`);card.style.setProperty('--mx-ry',`${(x-.5)*12}deg`);
        card.style.setProperty('--mx-gx',`${x*100}%`);card.style.setProperty('--mx-gy',`${y*100}%`);
        card.classList.add('mx-tilting');
      });
    });
    card.addEventListener('pointerleave',()=>{cancelAnimationFrame(raf);card.classList.remove('mx-tilting');card.style.removeProperty('--mx-rx');card.style.removeProperty('--mx-ry');});
  });
}

// Eyebrow labels decode into place when they scroll in.
const glyphs='01<>/_#+*';
const decode=el=>{
  const text=el.dataset.mxText;let frame=0;const frames=18;
  const tick=()=>{
    if(root.classList.contains('motion-paused')){el.textContent=text;return;}
    const done=Math.floor(text.length*frame/frames);
    el.textContent=text.slice(0,done)+[...text.slice(done)].map(ch=>ch===' '?' ':glyphs[Math.random()*glyphs.length|0]).join('');
    if(++frame<=frames)requestAnimationFrame(tick);else el.textContent=text;
  };tick();
};
const eio=new IntersectionObserver(entries=>entries.forEach(e=>{if(!e.isIntersecting)return;eio.unobserve(e.target);decode(e.target);}),{threshold:.6});
document.querySelectorAll('main .eyebrow').forEach(el=>{
  if(el.children.length||el.closest('.page-heading,.one-hero'))return;
  const text=el.textContent;if(text.trim().length<3||text.length>48)return;
  el.dataset.mxText=text;el.setAttribute('aria-label',text);eio.observe(el);
});
})();
