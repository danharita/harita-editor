"""Touch drag + pinch inside the embedded editor while the page is scrolled."""
from playwright.sync_api import sync_playwright
import re
from urllib.parse import unquote
ROOT='/home/claude/engine'
def route_cdn(route):
    m = re.match(r'https://cdn\.jsdelivr\.net/npm/((?:@[^/]+/)?[^@/]+)@[^/]+/(.*)', route.request.url)
    route.fulfill(path=f'{ROOT}/node_modules/{m.group(1)}/{m.group(2)}', headers={'access-control-allow-origin': '*', 'content-type': 'application/javascript'})
def route_fonts(route):
    route.fulfill(path='/home/claude/custom-fonts/' + unquote(route.request.url.split('/custom-fonts/')[1]), headers={'access-control-allow-origin': '*'})
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx.route('https://cdn.jsdelivr.net/**', route_cdn); ctx.route('https://danharita.github.io/**', route_fonts)
    page = ctx.new_page(); errs=[]; page.on('pageerror', lambda e: errs.append(str(e)))
    page.add_init_script('try{localStorage.clear()}catch(e){}')
    page.goto('http://localhost:8765/embed/mock/product.html#dhtest')
    page.wait_for_selector('.dh-start'); page.click('#CheckBoxCont_60199_225515'); page.click('.dh-start-btn')
    page.wait_for_selector('.dhe [data-el="loading"]', state='hidden', timeout=20000); page.wait_for_timeout(500)
    page.evaluate("window.scrollTo(0, document.querySelector('.dhe-stage').getBoundingClientRect().top + scrollY - 200)"); page.wait_for_timeout(300)
    cdp = ctx.new_cdp_session(page)
    def pos(kind):
        return page.evaluate("""(kind) => { const d = __dhe(), c = d.canvas, v = c.viewportTransform, r = c.upperCanvasEl.getBoundingClientRect();
          const o = d.state.surfaces.test.objects.find(o => o.type === kind); const fo = d.foMap.get(o.id);
          return { x: r.left + v[4] + fo.left * v[0], y: r.top + v[5] + fo.top * v[3], cx: o.cx, cy: o.cy, w: o.widthMm }; }""", kind)
    s = pos('symbol')
    cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[{'x':s['x'],'y':s['y']}]})
    for i in range(1,9): cdp.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':[{'x':s['x']+6*i,'y':s['y']+4*i}]})
    cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]}); page.wait_for_timeout(200)
    s2 = pos('symbol'); print(f"drag heart: moved {s2['cx']-s['cx']:.1f}, {s2['cy']-s['cy']:.1f} mm; page scrollY {page.evaluate('scrollY')}")
    pts = lambda d: [{'x': s2['x']-d/2,'y':s2['y'],'id':0},{'x':s2['x']+d/2,'y':s2['y'],'id':1}]
    cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':[pts(60)[0]]}); cdp.send('Input.dispatchTouchEvent', {'type':'touchStart','touchPoints':pts(60)})
    for i in range(1,11): cdp.send('Input.dispatchTouchEvent', {'type':'touchMove','touchPoints':pts(60+6*i)})
    cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[pts(120)[0]]}); cdp.send('Input.dispatchTouchEvent', {'type':'touchEnd','touchPoints':[]}); page.wait_for_timeout(300)
    s3 = pos('symbol'); print(f"pinch: width {s2['w']} -> {s3['w']} mm")
    print('errors', errs or 'none'); b.close()
