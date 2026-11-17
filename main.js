const { Plugin, PluginSettingTab, Setting, Modal, Menu, Notice, normalizePath } = require('obsidian');
const DEFAULTS = { pasteMenu: true, downloadCover: true, coverFolder: '链接卡片附件' };
function http(value) { const url = new URL(String(value).trim()); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('请填写不包含账号密码的 HTTP(S) 链接'); return url; }
function singleURL(text) { if (!text || /\s/.test(text.trim())) return null; try { return http(text).href; } catch (_) { return null; } }
function block(card) { return '```link-card\n' + JSON.stringify(card, null, 2).replace(/`/g, '\\u0060') + '\n```'; }
function markdown(title, url) { return '[' + title.replace(/[\\\[\]\r\n]/g, ' ').trim() + '](<' + url.replace(/>/g, '%3E') + '>)'; }
async function request(url) {
  let timer;
  try { const res = await Promise.race([require('obsidian').requestUrl({ url, throw: false }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('读取超过 20 秒')), 20000); })]); if (res.status < 200 || res.status >= 300) throw Error('HTTP ' + res.status); return res; }
  finally { clearTimeout(timer); }
}
function metadata(html, url, win) {
  const doc = new win.DOMParser().parseFromString(html, 'text/html');
  const meta = key => [...doc.querySelectorAll('meta')].find(el => (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase() === key)?.getAttribute('content')?.trim() || '';
  let image = ''; try { const value = meta('og:image') || meta('twitter:image'); if (value) image = http(new URL(value, url).href).href; } catch (_) {}
  return { url, title: (meta('og:title') || meta('twitter:title') || doc.title || new URL(url).hostname).slice(0, 300), description: (meta('og:description') || meta('description') || meta('twitter:description')).slice(0, 1200), site: (meta('og:site_name') || new URL(url).hostname).slice(0, 100), image };
}
function embedURL(url) {
  const u = http(url);
  if (/(^|\.)music\.163\.com$/.test(u.hostname)) { const id = u.searchParams.get('id') || u.hash.match(/[?&]id=(\d+)/)?.[1]; if (/^\d+$/.test(id || '')) return 'https://music.163.com/outchain/player?type=2&id=' + id + '&auto=0&height=66'; }
  if (u.hostname === 'youtu.be' || /(^|\.)youtube\.com$/.test(u.hostname)) { const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v'); if (/^[\w-]{11}$/.test(id || '')) return 'https://www.youtube-nocookie.com/embed/' + id; }
  if (/(^|\.)bilibili\.com$/.test(u.hostname)) { const id = u.pathname.match(/\/video\/(BV[\w]+)/)?.[1]; if (id) return 'https://player.bilibili.com/player.html?bvid=' + id + '&autoplay=0'; }
  return null;
}
class CardModal extends Modal {
  constructor(plugin, initial, save) { super(plugin.app); Object.assign(this, { plugin, initial, save }); }
  onOpen() {
    this.contentEl.createEl('h2', { text: '链接卡片' }); const fields = {};
    for (const [key, label] of [['url','链接'], ['title','标题'], ['description','简介'], ['image','封面（库内路径或图片 URL）']]) { const row = this.contentEl.createEl('label', { cls: 'nlc-field', text: label }); fields[key] = row.createEl(key === 'description' ? 'textarea' : 'input'); fields[key].value = this.initial[key] || ''; }
    const status = this.contentEl.createEl('p', { attr: { 'aria-live': 'polite' } });
    const fetch = this.contentEl.createEl('button', { text: '从网页读取信息' }); fetch.onclick = async () => { fetch.disabled = true; try { const card = await this.plugin.fetchCard(http(fields.url.value).href); for (const key of ['title','description','image']) fields[key].value = card[key] || ''; status.setText('读取完成，可继续修改。'); } catch (e) { status.setText('读取失败，可手动填写：' + e.message); } finally { fetch.disabled = false; } };
    const save = this.contentEl.createEl('button', { text: '保存卡片', cls: 'mod-cta' }); save.onclick = async () => { save.disabled = true; try { const card = { ...this.initial, ...Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v.value.trim()])) }; card.url = http(card.url).href; card.title ||= new URL(card.url).hostname; await this.save(card); this.close(); } catch(e) { status.setText(e.message); } finally { save.disabled = false; } };
  }
}
class Settings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() { this.containerEl.empty(); new Setting(this.containerEl).setName('粘贴链接时显示选择菜单').addToggle(c => c.setValue(this.plugin.options.pasteMenu).onChange(async v => { this.plugin.options.pasteMenu = v; await this.plugin.saveData(this.plugin.options); })); new Setting(this.containerEl).setName('封面保存到本地').setDesc('读取网页信息时下载封面，存放在「链接卡片附件」。失败时保留远程图片地址。').addToggle(c => c.setValue(this.plugin.options.downloadCover).onChange(async v => { this.plugin.options.downloadCover = v; await this.plugin.saveData(this.plugin.options); })); }
}
module.exports = class NotionLinkCards extends Plugin {
  async onload() {
    this.options = { ...DEFAULTS, ...await this.loadData() }; this.pending = new Map();
    this.addSettingTab(new Settings(this.app, this));
    this.registerMarkdownCodeBlockProcessor('link-card', (source, el, ctx) => this.render(source, el, ctx));
    this.registerEvent(this.app.workspace.on('editor-paste', (event, editor, view) => {
      if (!this.options.pasteMenu || event.defaultPrevented || event.clipboardData?.files.length || editor.getSelection()) return;
      const url = singleURL(event.clipboardData?.getData('text/plain')); if (!url) return;
      // Leave code blocks, inline code and fenced syntax alone.
      const before = editor.getRange({ line: 0, ch: 0 }, editor.getCursor());
      let fenced = false, marker = '';
      for (const line of before.split('\n')) { const match = line.match(/^\s{0,3}(`{3,}|~{3,})/); if (match) { if (!fenced) { fenced=true; marker=match[1][0]; } else if (match[1][0]===marker) fenced=false; } }
      if (fenced || (before.split('\n').at(-1).match(/`/g)?.length || 0) % 2) return;
      const original = event.clipboardData.getData('text/plain').trim();
      event.preventDefault(); const from = editor.getCursor(); editor.replaceSelection(original); const to = editor.getCursor();
      const replace = this.replacement(editor, view, from, to, original);
      const menu = new Menu();
      menu.addItem(i => i.setTitle('URL（保留原链接）').setIcon('link').onClick(()=>{}));
      menu.addItem(i => i.setTitle('提及（标题链接）').setIcon('at-sign').onClick(()=>this.convert(url,'mention',replace)));
      menu.addItem(i => i.setTitle('书签（封面卡片）').setIcon('bookmark').onClick(()=>this.convert(url,'bookmark',replace)));
      menu.addItem(i => i.setTitle('嵌入').setIcon('panel-top').onClick(()=>this.convert(url,'embed',replace)));
      const rect = editor.containerEl?.getBoundingClientRect?.() || this.app.workspace.containerEl.getBoundingClientRect(); menu.showAtPosition({ x: rect.left + Math.min(rect.width / 2, 320), y: rect.top + 80 });
    }));
    this.addCommand({ id: 'insert-card', name: '插入链接卡片', editorCallback: (editor, view) => { const from=editor.getCursor('from'), to=editor.getCursor('to'), original=editor.getSelection(), replace=this.replacement(editor,view,from,to,original); new CardModal(this,{url:singleURL(original)||''},card=>replace(block(card),true)).open(); } });
    this.addCommand({ id: 'convert-url', name: '将所选链接转为书签卡片', editorCallback: (editor,view)=>{ const original=editor.getSelection(), url=singleURL(original); if (!url) { new Notice('请先选中完整的 HTTP(S) 链接'); return; } this.convert(url,'bookmark',this.replacement(editor,view,editor.getCursor('from'),editor.getCursor('to'),original)); } });
  }
  replacement(editor, view, from, to, original) {
    const path = view.file?.path, snapshot = editor.getValue();
    return (text, standalone=false) => {
      if (!path || view.file?.path !== path || editor.getValue() !== snapshot || editor.getRange(from,to) !== original) { new Notice('笔记已变化，为避免覆盖内容，请重新选择链接后转换'); return false; }
      const prefix = standalone && from.ch ? '\n\n' : ''; const suffix = standalone ? '\n\n' : '';
      editor.replaceRange(prefix+text+suffix,from,to); return true;
    };
  }
  async convert(url, mode, replace) {
    if (mode==='embed') { if (!embedURL(url)) { new Notice('该网站未提供已支持的嵌入方式，已改为书签卡片'); mode='bookmark'; } else { replace(block({url, title:new URL(url).hostname, mode:'embed'}),true); return; } }
    let card; try { card=await this.fetchCard(url); } catch(e) { new Notice('网页信息读取失败，已使用基础卡片，可右键编辑：'+e.message); card={url,title:new URL(url).hostname,description:'',image:''}; }
    replace(mode==='mention'?markdown(card.title,url):block(card),mode!=='mention');
  }
  async fetchCard(url) {
    url=http(url).href; if (this.pending.has(url)) return this.pending.get(url);
    const task=(async()=>{ const response=await request(url); if (response.text.length>4*1024*1024) throw Error('网页内容过大'); const win=this.app.workspace.containerEl.ownerDocument.defaultView; const card=metadata(response.text,url,win); if (card.image && this.options.downloadCover) { try { card.image=await this.saveCover(card.image); } catch(e) { new Notice('封面未能保存到本地，将使用远程地址：'+e.message); } } return card; })();
    this.pending.set(url,task); try{return await task;}finally{this.pending.delete(url);}
  }
  async saveCover(url) {
    const response=await request(http(url).href); const mime=Object.entries(response.headers||{}).find(([k])=>k.toLowerCase()==='content-type')?.[1]?.split(';')[0]; const ext={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/avif':'avif'}[mime];
    if (!ext || !response.arrayBuffer.byteLength || response.arrayBuffer.byteLength>10*1024*1024) throw Error('封面格式不支持或超过 10 MB');
    const folder='链接卡片附件'; if (!this.app.vault.getAbstractFileByPath(folder)) { try {await this.app.vault.createFolder(folder);} catch(e) {if (!this.app.vault.getAbstractFileByPath(folder)) throw e;} }
    const path=normalizePath(folder+'/'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10)+'.'+ext); await this.app.vault.createBinary(path,response.arrayBuffer); return path;
  }
  render(source, el, ctx) {
    let card; try { card=JSON.parse(source); card.url=http(card.url).href; } catch(e) {el.createEl('p',{text:'链接卡片格式错误：'+e.message});return;}
    if (card.mode==='embed' && embedURL(card.url)) {
      const src=embedURL(card.url), music=new URL(src).hostname==='music.163.com';
      const box=el.createDiv({cls:'nlc-embed '+(music?'nlc-embed-music':'nlc-embed-video')});
      box.createEl('iframe',{attr:{src,title:card.title|| (music?'网易云音乐播放器':'视频播放器'),sandbox:'allow-scripts allow-same-origin allow-popups',allow:'fullscreen; encrypted-media; picture-in-picture',loading:'eager',referrerpolicy:'strict-origin-when-cross-origin',scrolling:'no',frameborder:'0'}});
      box.oncontextmenu=event=>{event.preventDefault();const menu=new Menu();menu.addItem(i=>i.setTitle('在浏览器中打开原链接').setIcon('external-link').onClick(()=>{el.ownerDocument.defaultView.open(card.url,'_blank','noopener,noreferrer');}));menu.showAtMouseEvent(event);};
      return;
    }
    const link=el.createEl('a',{cls:'nlc-card',href:card.url,attr:{target:'_blank',rel:'noopener noreferrer','aria-label':String(card.title||card.url)}});
    if (typeof card.image==='string' && card.image) { let src=''; try {src=http(card.image).href;}catch(_){const f=this.app.metadataCache.getFirstLinkpathDest(card.image,ctx.sourcePath)||this.app.vault.getAbstractFileByPath(card.image);if(f)src=this.app.vault.getResourcePath(f);} if(src){const img=link.createEl('img',{cls:'nlc-cover',attr:{src,alt:'',loading:'lazy',referrerpolicy:'no-referrer'}});img.onerror=()=>img.remove();} }
    const content=link.createDiv({cls:'nlc-body'}); content.createSpan({cls:'nlc-site',text:String(card.site||new URL(card.url).hostname)});content.createEl('strong',{cls:'nlc-title',text:String(card.title||card.url)});if(card.description)content.createEl('p',{cls:'nlc-description',text:String(card.description)});content.createSpan({cls:'nlc-url',text:card.url});
    link.oncontextmenu=event=>{event.preventDefault();const menu=new Menu();menu.addItem(i=>i.setTitle('编辑卡片').setIcon('pencil').onClick(()=>new CardModal(this,card,async updated=>{const section=ctx.getSectionInfo(el);const file=this.app.vault.getAbstractFileByPath(ctx.sourcePath);if(!section||!file)throw Error('请在源码中编辑此卡片');const expected=section.text.split('\n').slice(section.lineStart,section.lineEnd+1).join('\n');await this.app.vault.process(file,text=>{const lines=text.split('\n');if(lines.slice(section.lineStart,section.lineEnd+1).join('\n')!==expected)throw Error('笔记内容已变化，请重新打开卡片编辑');lines.splice(section.lineStart,section.lineEnd-section.lineStart+1,block(updated));return lines.join('\n');});}).open()));menu.showAtMouseEvent(event);};
  }
};
