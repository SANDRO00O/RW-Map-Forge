"""End-to-end browser test of the whole site (dev server with mock upstream data).
   Usage: MOCK=1 node tests/dev-server.mjs &   then   python3 tests/e2e.py [base_url]"""
import io, re, sys, json, base64, gzip, struct
import xml.etree.ElementTree as ET
from PIL import Image, ImageDraw
from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8787'
EMOJI = re.compile('[\U0001F300-\U0001FAFF\u2600-\u27BF\u2B50\u2B06\u2705\u274C\uFE0F]')

def tile_png():
    im = Image.new('RGB', (256, 256), (222, 218, 208)); d = ImageDraw.Draw(im)
    for i in range(0, 256, 32): d.line([(i, 0), (i, 255)], fill=(200, 196, 186)); d.line([(0, i), (255, i)], fill=(200, 196, 186))
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()
TILE = tile_png()

def run(viewport, tag, mobile=False):
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport=viewport, device_scale_factor=2 if mobile else 1, accept_downloads=True, has_touch=mobile, is_mobile=mobile)
        pg = ctx.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append('pageerror: ' + str(e)))
        pg.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' else None)
        pg.route(re.compile(r'https://(.*\.basemaps\.cartocdn\.com|server\.arcgisonline\.com)/.*'), lambda r: r.fulfill(status=200, body=TILE, content_type='image/png'))
        pg.goto(BASE + '/'); pg.wait_for_selector('#map canvas'); pg.wait_for_timeout(700)
        pg.screenshot(path=f'/tmp/forge_{tag}_1_location.png')

        # --- no native widgets, no emoji
        assert pg.locator('select').count() == 0, 'native <select> present'
        assert pg.locator('input[type=checkbox],input[type=range],input[type=number]').count() == 0, 'native checkbox/range/number present'
        text = pg.evaluate("document.body.innerText")
        assert not EMOJI.search(text), 'emoji found in text: ' + str(EMOJI.findall(text))

        # --- location: type coordinates, search, layer switch
        if mobile:
            pg.screenshot(path=f'/tmp/forge_{tag}_1b_collapsed.png'); pg.click('#dockToggle'); pg.wait_for_timeout(300)
        pg.fill('#inLat', '46.55'); pg.dispatch_event('#inLat', 'change')
        pg.fill('#inLon', '728.5988'); pg.dispatch_event('#inLon', 'change')
        print(tag, 'lon normalised ->', pg.input_value('#inLon'))
        pg.fill('#inLon', '7.98'); pg.dispatch_event('#inLon', 'change')
        pg.fill('#searchInput', 'Interlaken'); pg.wait_for_selector('#searchResults button', timeout=5000)
        pg.screenshot(path=f'/tmp/forge_{tag}_2_search.png')
        pg.click('#searchResults button'); pg.wait_for_timeout(400)
        print(tag, 'after search centre:', pg.input_value('#inLat'), pg.input_value('#inLon'))
        pg.fill('#inLat', '46.55'); pg.dispatch_event('#inLat', 'change'); pg.fill('#inLon', '7.98'); pg.dispatch_event('#inLon', 'change')
        pg.click('#btnLayers'); pg.wait_for_selector('#popovers .pop-item'); pg.click('#popovers .pop-item:nth-child(3)'); pg.wait_for_timeout(300)
        pg.click('#segPreset button:nth-child(1)')           # S = 128
        print(tag, 'extent:', pg.inner_text('#extent'))
        pg.screenshot(path=f'/tmp/forge_{tag}_3_location_ready.png')

        # --- settings via custom controls
        pg.click('#btnToSettings'); pg.wait_for_selector('#settingsCards .card'); pg.wait_for_timeout(300)
        pg.screenshot(path=f'/tmp/forge_{tag}_4_settings.png', full_page=False)
        pg.click('#settingsCards .sel-btn >> nth=1'); pg.wait_for_selector('#popovers .pop-item'); pg.click('#popovers .pop-item:nth-child(3)')
        sl = pg.locator('#settingsCards .slider').first; box = sl.bounding_box()
        pg.mouse.click(box['x'] + box['width'] * 0.5, box['y'] + box['height'] / 2)
        print(tag, 'slider value:', pg.locator('#settingsCards output').first.inner_text())

        # --- generate
        pg.click('#btnGenerate'); pg.wait_for_selector('#progress:not([hidden])')
        pg.screenshot(path=f'/tmp/forge_{tag}_5_progress.png')
        pg.wait_for_selector('#view-editor.is-active', timeout=60000); pg.wait_for_timeout(900)
        print(tag, 'summary:', pg.inner_text('#summary'))
        pg.screenshot(path=f'/tmp/forge_{tag}_6_editor.png')

        # --- editor tools: place player 3 and a resource, zoom to texture mode
        if mobile and pg.locator('#panel.is-open').count() == 0: pass
        pg.click('#tools [data-tool=spawn]')
        cv = pg.locator('#cv').bounding_box()
        pg.mouse.click(cv['x'] + cv['width'] * 0.5, cv['y'] + cv['height'] * 0.5); pg.wait_for_timeout(500)
        pg.click('#tools [data-tool=pool]'); pg.mouse.click(cv['x'] + cv['width'] * 0.55, cv['y'] + cv['height'] * 0.55); pg.wait_for_timeout(300)
        print(tag, 'after edit:', pg.inner_text('#summary'))
        pg.evaluate("""() => { const E = window.Editor, st = E.st; const s = st.spawns[st.spawns.length-1]; E.view.cx = s.x; E.view.cy = s.y; E.view.s = 18; E.redraw(); }""")
        pg.wait_for_timeout(500); pg.screenshot(path=f'/tmp/forge_{tag}_7_zoom.png')

        # --- export
        if mobile: pass
        pg.click('#btnExport') if not mobile else (pg.click('#btnPanel'), pg.wait_for_timeout(400), pg.click('#btnExport'))
        pg.wait_for_selector('#app > .overlay:not(#progress) .dialog'); pg.wait_for_timeout(300)
        pg.screenshot(path=f'/tmp/forge_{tag}_8_export.png')
        with pg.expect_download(timeout=30000) as dl:
            pg.click('#app > .overlay:not(#progress) .dialog-actions .btn.primary')
        d = dl.value; path = f'/tmp/forge_{tag}.tmx'; d.save_as(path)
        print(tag, 'downloaded:', d.suggested_filename)
        text = open(path, encoding='utf-8').read()
        r = ET.fromstring(text.encode())
        sets = [(int(t.get('firstgid')), t.get('name') or t.get('source').split('/')[-1]) for t in r.findall('tileset')]
        W = int(r.get('width'))
        lay = {}
        for l in r.findall('layer'):
            raw = gzip.decompress(base64.b64decode(l.find('data').text.strip())); lay[l.get('name')] = struct.unpack('<%dI' % (len(raw)//4), raw)
        def setof(g):
            best = None
            for fg, nm in sets:
                if g >= fg: best = (fg, nm)
            return best
        it = lay['Items']; pools = 0
        for i, g in enumerate(it):
            if g:
                fg, nm = setof(g)
                if nm.startswith('misc') and g - fg == 0:
                    x, y = i % W, i // W
                    if all(it[(y+dy)*W+x+dx] and it[(y+dy)*W+x+dx]-fg == dy*3+dx for dy in range(3) for dx in range(3)): pools += 1
        print(tag, 'TMX ok: size', W, 'x', r.get('height'), '| tilesets', len(sets), '| full 3x3 pools', pools, '| empty ground', sum(1 for g in lay['Ground'] if g == 0), '| source sample:', r.find('tileset').get('source'))
        print(tag, 'ERRORS:', [e for e in errs if 'ERR_' not in e])
        b.close()

run({'width': 1366, 'height': 820}, 'desktop')
run({'width': 390, 'height': 780}, 'mobile', mobile=True)
