/**
 * Feedlet bookmarklets.
 *
 * The source Feedlet injected a <script> from the Fever server into the page
 * (feedlet_link + feedlet/bookmarklet.php). Content Security Policy blocks
 * that on many sites, so the full Feedlet is now self-contained: it reads the
 * page's feed <link> elements and feed-like anchors, then navigates to the
 * Feedlet page. Navigation is not subject to the page's script-src. The
 * simple Feedlet only sends the page address and lets the server discover
 * feeds, for pages where even an inline bookmarklet is refused.
 *
 * Query format matches the source so old and new links share one parser:
 * url, title, feeds[n][href], feeds[n][title], feeds[n][type] (link|a|feed).
 * The source also split protocols into separate *[protocol] fields; the page
 * still accepts those, but new links send complete URLs.
 */

const MAX_FEEDS = 30;
const MAX_TITLE = 120;

function fullSource(target: string): string {
  return `(function(){
var B=${JSON.stringify(target)},d=document,u=location.href,t=d.title||'',f=[],seen={},i,l,a,s,m,g,h;
function add(x,n,y){if(!x||seen[x]||!/^(https?|feed):/i.test(x)||f.length>=${MAX_FEEDS})return;seen[x]=1;f.push([x,String(n||'').replace(/\\s+/g,' ').replace(/^ | $/g,'').slice(0,${MAX_TITLE}),y]);}
if(d.xmlVersion||/^feed:/i.test(u)||/(rss|atom)\\+xml|[/+]xml$/i.test(d.contentType||'')){add(u,t,'feed');}else{
var L=d.getElementsByTagName('link');
for(i=0;i<L.length;i++){l=L[i];if(l.href&&/alternate/i.test(l.rel||'')&&/^application\\/(rss|atom)\\+xml$/i.test(l.type||''))add(l.href,l.title||l.type.replace(/^application\\/(rss|atom)\\+xml$/i,'$1'),'link');}
var A=d.getElementsByTagName('a');
for(i=0;i<A.length;i++){a=A[i];if(!a.href)continue;s=a.href+' '+(a.title||'')+' '+(a.textContent||'')+' '+(a.rel||'')+' '+(a.id||'');
if(/\\b(rss|atom|feed|xml|syndicate)\\b/i.test(s)){m=a.title||'';if(!/\\S/.test(m)){g=a.getElementsByTagName('img')[0];m=(g&&g.alt)||a.textContent||'';}
h=a.href.replace(/^https?:\\/\\/(www\\.)?(netvibes|bloglines)\\.com\\/(subscribe\\.php\\?url=|sub\\/)(.+)$/i,'$4');
if(h!==a.href){try{h=decodeURIComponent(h);}catch(e){}}
add(h,m,'a');}}}
var q='?url='+encodeURIComponent(u)+'&title='+encodeURIComponent(t.slice(0,300));
for(i=0;i<f.length;i++){q+='&feeds['+i+'][href]='+encodeURIComponent(f[i][0])+'&feeds['+i+'][title]='+encodeURIComponent(f[i][1])+'&feeds['+i+'][type]='+f[i][2];}
location.href=B+q;})();`;
}

function simpleSource(target: string): string {
  return `(function(){location.href=${JSON.stringify(target)}+'?url='+encodeURIComponent(location.href);})();`;
}

/** Absolute Feedlet page URL, e.g. https://host/base/feedlet */
export function bookmarkletHref(feedletPageUrl: string, variant: "full" | "simple"): string {
  const source = variant === "full" ? fullSource(feedletPageUrl) : simpleSource(feedletPageUrl);
  return `javascript:${encodeURIComponent(source.replace(/\n/g, ""))}`;
}
