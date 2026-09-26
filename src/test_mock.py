"""End-to-end check of loader + editor on the mock product page, phone size.
jsdelivr and GitHub Pages requests are served from local copies."""
import os, re, zipfile
from urllib.parse import unquote
from playwright.sync_api import sync_playwright

ROOT = '/home/claude/engine'
URL = 'http://localhost:8765/embed/mock/product.html#dhtest'
OUT = ROOT + '/embed/check'
os.makedirs(OUT, exist_ok=True)
fails = []

def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: fails.append(msg)

def route_cdn(route):
    m = re.match(r'https://cdn\.jsdelivr\.net/npm/((?:@[^/]+/)?[^@/]+)@[^/]+/(.*)', route.request.url)
    route.fulfill(path=f'{ROOT}/node_modules/{m.group(1)}/{m.group(2)}', headers={'access-control-allow-origin': '*', 'content-type': 'application/javascript'})

def route_fonts(route):
    name = unquote(route.request.url.split('/custom-fonts/')[1])
    route.fulfill(path=f'/home/claude/custom-fonts/{name}', headers={'access-control-allow-origin': '*'})

def fields(page):
    return page.evaluate("""() => Object.fromEntries([...document.querySelectorAll('#FrmCatalog input.clsTextChooseProduct')].map(i => [i.getAttribute('property_name'), i.value]))""")

def vis(page, sel):
    return page.evaluate("(s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null; }", sel)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True, accept_downloads=True)
    ctx.route('https://cdn.jsdelivr.net/**', route_cdn)
    ctx.route('https://danharita.github.io/**', route_fonts)
    page = ctx.new_page()
    errs, logs = [], []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: logs.append(m.type + ': ' + m.text) if m.type in ('error', 'warning') else None)
    page.add_init_script('try{localStorage.clear()}catch(e){}')
    page.goto(URL)
    page.wait_for_selector('.dh-choose', timeout=10000)
    page.wait_for_timeout(500)

    # --- chooser state -------------------------------------------------
    check(page.evaluate("[...document.querySelectorAll('.fotorama img')].every(i => !i.alt.startsWith('engrave-bg-'))"), 'engrave-bg image removed from the gallery')
    check(not vis(page, '#danWrap_1') and not vis(page, '#danWrap_2'), 'chooser: old previews hidden')
    check(not vis(page, 'ul.clsUlChooseProduct') and not vis(page, '#CheckBoxCont_60199_225515'), 'chooser: font + symbol rows hidden')
    check(not vis(page, 'input[property_name="קישור לעיצוב"]'), 'design-link field hidden')
    check(vis(page, "input[property_name=\"הערות מיוחדות/תוספות של סמלים וכו'\"]"), 'notes field still visible')
    check(not vis(page, '.dh-start'), 'small bar hidden in chooser state')
    page.click('#BtnAddToBasket_Anchor')
    page.wait_for_timeout(200)
    check(page.evaluate('window.__submits.length') == 0, 'chooser: add to cart blocked')
    check(vis(page, '.dh-choose-note'), 'chooser: note shown after cart tap')
    page.screenshot(path=OUT + '/0-choose.png', full_page=True)

    # --- "עצבו בשבילי" -> today's view ---------------------------------
    page.click('.dh-choose-btn[data-dh="us"]')
    page.wait_for_timeout(300)
    check(vis(page, '#danWrap_1') and vis(page, 'ul.clsUlChooseProduct'), 'default: previews + font row back')
    check(not vis(page, '.dh-choose') and vis(page, '.dh-start'), 'default: chooser gone, small bar shown')
    check(not vis(page, 'input[property_name="קישור לעיצוב"]'), 'design-link field still hidden in default')
    page.click('#BtnAddToBasket_Anchor')
    page.wait_for_timeout(200)
    check(page.evaluate('window.__submits.length') == 1, 'default: add to cart works')

    # customer types in the old preview, picks a font and a symbol
    page.click('#danEditable_1'); page.keyboard.type('השף של הבית')
    page.click('li.clsLIChooseProduct[textselectedproperty="כתב יד"]')
    page.click('#CheckBoxCont_60199_225515')
    page.wait_for_timeout(200)

    # --- into the editor ------------------------------------------------
    page.click('.dh-start-btn')
    page.wait_for_selector('.dhe [data-el="loading"]', state='hidden', timeout=20000)
    page.wait_for_timeout(300)
    check(not vis(page, '.dh-start') and not vis(page, '.dh-choose'), 'editor: bars hidden')
    check(not vis(page, '#danWrap_1') and not vis(page, 'ul.clsUlChooseProduct'), 'editor: default view hidden')
    tabs = page.eval_on_selector_all('.dhe-tabs button', 'bs => bs.map(b => b.textContent.trim())')
    check(len(tabs) == 2 and tabs[0].startswith('קרש') and tabs[1].startswith('סכין'), f'tabs {tabs}')
    surf = page.evaluate("__dhe().SURFACES.map(s => ({slot: s.slot, img: s.img.w + 'x' + s.img.h}))")
    check([s['slot'] for s in surf] == ['board', 'knife'], f'surface order from -1/-2: {surf}')
    check(surf[0]['img'] == '800x571' and surf[1]['img'] == '1140x480', f'both from real images (no placeholder): {surf}')
    st = page.evaluate("JSON.parse(JSON.stringify(__dhe().state))")
    knife = st['surfaces']['knife']['objects']
    board = st['surfaces']['board']['objects']
    check(knife[0]['text'] == 'השף של הבית' and knife[0]['font'] == 'ktavyad', f"knife text imported: {knife[0]['text']!r} {knife[0]['font']}")
    check(any(o['type'] == 'symbol' and o['symbol'] == 'heart' for o in board), 'ticked heart imported onto the board')

    # --- inline editing: tap the empty box, write on the product --------
    def tap_stage(fx=0.5, fy=0.5):
        bb = page.locator('.dhe-stage').bounding_box()
        page.touchscreen.tap(bb['x'] + bb['width'] * fx, bb['y'] + bb['height'] * fy)
    tap_stage()
    page.wait_for_timeout(250)
    check(vis(page, '.dhe-edit'), 'tap on empty text opens the writing bar')
    check(page.evaluate("document.activeElement === document.querySelector('.dhe-edit textarea')"), 'writing bar focused')
    page.keyboard.type('משפחת כהן')
    page.keyboard.press('Enter')
    page.keyboard.type('בית חם')
    page.wait_for_timeout(700)
    check(page.evaluate("__dhe().state.surfaces.board.objects[0].text") == 'משפחת כהן\nבית חם', 'text lands on the board live')
    f = fields(page)
    check(f['טקסט לחריטה קרש, שורה 1'] == 'משפחת כהן' and f['טקסט לחריטה קרש, שורה 2'] == 'בית חם', f"board fields: {f['טקסט לחריטה קרש, שורה 1']!r} / {f['טקסט לחריטה קרש, שורה 2']!r}")
    check(f['טקסט לחריטה סכין, שורה 1'] == 'השף של הבית', 'knife field kept')
    page.screenshot(path=OUT + '/2-inline-edit.png', full_page=True)
    # done button closes the bar
    page.click('.dhe-edit [data-el="editDone"]')
    page.wait_for_timeout(150)
    check(not vis(page, '.dhe-edit'), 'done button closes the writing bar')
    # second tap on the (now full) text reopens it
    tap_stage()
    page.wait_for_timeout(250)
    check(vis(page, '.dhe-edit'), 'tap on text reopens the writing bar')
    # tap far away deselects and closes
    tap_stage(0.05, 0.04)
    page.wait_for_timeout(250)
    check(not vis(page, '.dhe-edit'), 'tap outside closes the writing bar')

    # font chip -> the page's font button follows (first text box = board)
    tap_stage()
    page.wait_for_timeout(300)
    page.click('.dhe-edit [data-el="editDone"]')
    page.wait_for_timeout(150)
    page.click('.dhe-chip[data-font="david"]')
    page.wait_for_timeout(700)
    check(page.evaluate("document.querySelector('li.clsSelected') && document.querySelector('li.clsSelected').getAttribute('textselectedproperty')") == 'דפוס דוד', 'font button follows the editor')

    # symbols: add the crown, a third is refused (row max is 2)
    page.click('.dhe [data-el="btnAddSym"]')
    page.click('.dhe-sym:has-text("כתר")')
    page.wait_for_timeout(600)
    checked = page.evaluate("[...document.querySelectorAll('.elm_extra_product_checkList:checked')].map(c => c.id)")
    check(sorted(checked) == ['CheckBoxCont_60199_225515', 'CheckBoxCont_60199_225516'], f'symbols ticked: {checked}')
    page.click('.dhe [data-el="btnAddSym"]')
    page.click('.dhe-sym:has-text("כוכב")')
    page.wait_for_timeout(200)
    check('עד 2 סמלים' in page.inner_text('.dhe-toast'), 'third symbol refused: ' + page.inner_text('.dhe-toast'))
    check(page.evaluate("window.__tooMany || 0") == 0, 'never exceeded the row maximum')

    # add to cart before saving is blocked
    page.click('#BtnAddToBasket_Anchor')
    page.wait_for_timeout(200)
    check(page.evaluate('window.__submits.length') == 1, 'editor: add to cart blocked before saving')
    check('שמרו קודם' in page.inner_text('.dhe-toast'), 'nag shown: ' + page.inner_text('.dhe-toast'))

    # save -> zip download, design field, status
    with page.expect_download() as dl:
        page.click('.dhe [data-el="btnSave"]')
    d = dl.value
    zpath = OUT + '/' + d.suggested_filename
    d.save_as(zpath)
    page.wait_for_timeout(300)
    names = zipfile.ZipFile(zpath).namelist()
    check(any(n.endswith('_board.dxf') for n in names) and any(n.endswith('_knife.dxf') for n in names), f'zip: {names}')
    f = fields(page)
    check(f['קישור לעיצוב'].startswith('עוצב ע״י הלקוח') and len(f['קישור לעיצוב']) <= 100, 'design field: ' + f['קישור לעיצוב'])
    check('נשמר' in page.inner_text('.dhe [data-el="status"]'), 'status: ' + page.inner_text('.dhe [data-el="status"]'))
    page.click('#BtnAddToBasket_Anchor')
    page.wait_for_timeout(200)
    subs = page.evaluate('window.__submits')
    check(len(subs) == 2 and subs[-1]['err'] is None, f'add to cart after saving ok')

    # a change after saving blocks again
    page.click('.dhe [data-el="panelSym"] [data-nudge="up"]') if page.is_visible('.dhe [data-el="panelSym"]') else page.click('.dhe [data-el="panelText"] [data-nudge="up"]')
    page.wait_for_timeout(200)
    check('שינויים' in page.inner_text('.dhe [data-el="status"]'), 'status after a change: ' + page.inner_text('.dhe [data-el="status"]'))
    page.click('#BtnAddToBasket_Anchor')
    page.wait_for_timeout(200)
    check(page.evaluate('window.__submits.length') == 2, 'blocked again after a change')
    page.screenshot(path=OUT + '/3-saved.png', full_page=True)
    z = zipfile.ZipFile(zpath)
    open(OUT + '/board.dxf', 'wb').write(z.read([n for n in names if n.endswith('_board.dxf')][0]))
    open(OUT + '/board_preview.jpg', 'wb').write(z.read([n for n in names if n.endswith('_board_preview.jpg')][0]))

    # --- back to "עצבו בשבילי" ------------------------------------------
    page.click('.dhe [data-el="btnForMe"]')
    page.wait_for_timeout(400)
    check(not vis(page, '.dhe'), 'editor hidden')
    check(vis(page, '.dh-start') and vis(page, '#danWrap_2') and vis(page, 'ul.clsUlChooseProduct'), 'default view back with the small bar')
    check(not vis(page, '.dh-choose'), 'chooser not shown again')
    check(page.inner_text('#danEditable_2').replace('\n', '|') == 'משפחת כהן|בית חם', 'old preview shows the text: ' + page.inner_text('#danEditable_2'))
    f = fields(page)
    check(f['קישור לעיצוב'] == '', 'design field cleared')
    check(not vis(page, 'input[property_name="קישור לעיצוב"]'), 'design-link field still hidden')
    page.click('#BtnAddToBasket_Anchor')
    page.wait_for_timeout(200)
    check(page.evaluate('window.__submits.length') == 3, 'add to cart works in the default view')
    page.screenshot(path=OUT + '/4-back.png', full_page=True)

    # open again: the design is still there
    page.click('.dh-start-btn')
    page.wait_for_timeout(600)
    n = page.evaluate("__dhe().state.surfaces.board.objects.length")
    check(n == 3, f'design kept on reopening ({n} objects on the board)')
    print('page errors:', errs or 'none')
    print('console:', [l for l in logs if 'favicon' not in l] or 'none')
    b.close()

print('\nFAILED:' if fails else '\nALL PASSED', fails if fails else '')
