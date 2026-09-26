"""Desktop: hint text on the empty box, double-click to edit, drag-from-near."""
import re
from urllib.parse import unquote
from playwright.sync_api import sync_playwright
ROOT='/home/claude/engine'
def route_cdn(route):
    m = re.match(r'https://cdn\.jsdelivr\.net/npm/((?:@[^/]+/)?[^@/]+)@[^/]+/(.*)', route.request.url)
    route.fulfill(path=f'{ROOT}/node_modules/{m.group(1)}/{m.group(2)}', headers={'access-control-allow-origin':'*','content-type':'application/javascript'})
def route_fonts(route):
    route.fulfill(path='/home/claude/custom-fonts/'+unquote(route.request.url.split('/custom-fonts/')[1]), headers={'access-control-allow-origin':'*'})
fails=[]
def check(c,m):
    print(('PASS ' if c else 'FAIL ')+m); 
    if not c: fails.append(m)
with sync_playwright() as p:
    b=p.chromium.launch()
    ctx=b.new_context(viewport={'width':1200,'height':900})  # desktop, fine pointer
    ctx.route('https://cdn.jsdelivr.net/**', route_cdn); ctx.route('https://danharita.github.io/**', route_fonts)
    page=ctx.new_page(); errs=[]; page.on('pageerror', lambda e: errs.append(str(e)))
    page.add_init_script('try{localStorage.clear()}catch(e){}')
    page.goto('http://localhost:8765/embed/mock/product.html#dhtest')
    page.wait_for_selector('.dh-choose'); page.click('.dh-choose-btn[data-dh="self"]')
    page.wait_for_selector('.dhe [data-el="loading"]', state='hidden', timeout=20000); page.wait_for_timeout(500)
    check(page.evaluate("matchMedia('(pointer: coarse)').matches")==False, 'fine pointer (desktop)')
    # hint present on the empty box
    empty = page.evaluate("__dhe().state.surfaces.board.objects.find(o=>o.type==='text' && !o.text.trim())")
    check(empty is not None, 'board starts with an empty text box')
    def screen(kind, full=False):
        return page.evaluate("""(kind)=>{const d=__dhe(),c=d.canvas,v=c.viewportTransform,r=c.upperCanvasEl.getBoundingClientRect();
          const o=kind==='empty'?d.state.surfaces.board.objects.find(o=>o.type==='text'&&!o.text.trim()):d.state.surfaces.board.objects.find(o=>o.type===kind);
          const fo=d.foMap.get(o.id);return{x:r.left+v[4]+fo.left*v[0],y:r.top+v[5]+fo.top*v[3],id:o.id};}""", kind)
    # double-click the empty box -> writing bar opens
    s=screen('empty'); page.mouse.dblclick(s['x'], s['y']); page.wait_for_timeout(300)
    check(page.is_visible('.dhe-edit'), 'double-click opens the writing bar on desktop')
    page.fill('.dhe-edit textarea', 'שלום עולם'); page.wait_for_timeout(500)
    page.click('.dhe-edit [data-el="editDone"]'); page.wait_for_timeout(200)
    check(page.evaluate("__dhe().state.surfaces.board.objects[0].text")=='שלום עולם', 'text set by double-click edit')
    # drag from ~30px away from the text (near, not on) moves it
    t=screen('text'); before=page.evaluate("(id)=>{const o=__dhe().state.surfaces.board.objects.find(o=>o.id===id);return[o.cx,o.cy];}", t['id'])
    page.mouse.move(t['x'], t['y']-70); page.mouse.down(); 
    for i in range(1,9): page.mouse.move(t['x']+10*i, t['y']-70+6*i)
    page.mouse.up(); page.wait_for_timeout(200)
    after=page.evaluate("(id)=>{const o=__dhe().state.surfaces.board.objects.find(o=>o.id===id);return[o.cx,o.cy];}", t['id'])
    check(abs(after[0]-before[0])+abs(after[1]-before[1])>3, f'drag from near moved the text on desktop: {before} -> {after}')
    # drag on the body moves it too (fabric)
    t=screen('text'); before=page.evaluate("(id)=>{const o=__dhe().state.surfaces.board.objects.find(o=>o.id===id);return[o.cx,o.cy];}", t['id'])
    page.mouse.move(t['x'], t['y']); page.mouse.down()
    for i in range(1,9): page.mouse.move(t['x']-8*i, t['y']+4*i)
    page.mouse.up(); page.wait_for_timeout(200)
    after=page.evaluate("(id)=>{const o=__dhe().state.surfaces.board.objects.find(o=>o.id===id);return[o.cx,o.cy];}", t['id'])
    check(abs(after[0]-before[0])+abs(after[1]-before[1])>3, f'drag on the body moved it: {before} -> {after}')
    page.screenshot(path=ROOT+'/embed/check/desktop.png')
    print('errors', errs or 'none')
    b.close()
print('\nFAILED' if fails else '\nALL PASSED', fails)
