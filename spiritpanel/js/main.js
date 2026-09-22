/* MXNestSpirit — panneau. Le calcul tourne ici, dans Chrome. */
(function () {
  'use strict';

  var cancelled = false;
  /* Un plan par document Illustrator. docKey = le document dont le panneau
     montre l'état ; pendant un calcul il ne change PAS, même si on passe sur
     un autre onglet : la recherche continue en fond pour son document. */
  var docKey = null, docName = '', docStates = {};
  /* Stickers : les modèles sont communs (on peut les prendre dans un autre
     fichier), les lots calculés appartiennent au plan du document. */
  var fillers = [null, null, null], fillResults = [null, null, null];

  var cs = new CSInterface();
  var $ = function (id) { return document.getElementById(id); };
  var parts = [], result = null, busy = false, session = '';

  function log(m) {
    var e = $('log');
    var lines = (m + '\n' + e.textContent).split('\n');
    if (lines.length > 40) lines = lines.slice(0, 40);   /* sinon il enfle sans fin */
    e.textContent = lines.join('\n');
  }
  function hint(m, cls) { var h = $('hint'); h.textContent = m; h.className = 'hint' + (cls ? ' ' + cls : ''); }
  function T(key, vars, fr) { var s = I18N.t(key, vars); return s === null ? fr : s; }
  function esc(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
  function call(fn, args, cb) {
    var a = (args || []).map(function (v) { return '"' + esc(v) + '"'; }).join(',');
    cs.evalScript(fn + '(' + a + ')', function (r) { cb(String(r)); });
  }
  function lock(on) {
    var wasBusy = busy;
    busy = on;
    /* Le Stop est le SEUL bouton actif pendant un calcul, et il doit l'être
       quel que soit le moteur. Il partait désactivé dans la page et rien ne le
       rallumait : il était donc gris au moment précis où il sert. */
    if ($('stop')) $('stop').disabled = !on;
    $('scan').disabled = on;
    $('diag').disabled = on;
    $('run').disabled = on || !parts.length;
    $('apply').disabled = on || !result;
    if ($('hybrid')) $('hybrid').disabled = on || !parts.length;
    $('marks').disabled = on;
    $('msave').disabled = on;
    $('dobleed').disabled = on;
    $('reset').disabled = on;
    ['inklist', 'inkselect', 'inkapply', 'inkrename',
     'fpick1', 'fpick2', 'fpick3', 'fclear', 'profload', 'profsave', 'profren', 'profdel'].forEach(function (id) {
      if ($(id)) $(id).disabled = on;
    });
    if ($('ffill')) $('ffill').disabled = on || !result || !(fillers[0] || fillers[1] || fillers[2]);
    if ($('fapply')) $('fapply').disabled = on || !(fillResults[0] || fillResults[1] || fillResults[2]);
    /* fin d'un calcul : si on a changé d'onglet entre-temps, on bascule tout
       de suite sur l'état du document actif, sans attendre le sondage. */
    if (wasBusy && !on) setTimeout(watchDocument, 0);
  }


  /* ---------- calcul en parallèle ----------
     Un seul cœur travaillait pendant que les sept autres regardaient. Chaque
     ouvrier reçoit le même jeu de pièces et calcule une tranche des essais ;
     la liste des essais étant déterministe, chacun sait exactement lesquels
     lui reviennent sans qu'on ait à se les transmettre.
     Si les ouvriers ne démarrent pas (installation verrouillée), on retombe
     sans bruit sur le calcul séquentiel. */
  var WORKER_SRC = null;

  function workerSource(cb) {
    if (WORKER_SRC !== null) { cb(WORKER_SRC); return; }
    try {
      var x = new XMLHttpRequest();
      x.open('GET', 'js/engine.js', true);
      x.onload = function () {
        WORKER_SRC = x.responseText + '\n' + GLUE;
        cb(WORKER_SRC);
      };
      x.onerror = function () { cb(null); };
      x.send();
    } catch (e) { cb(null); }
  }

  var REBUILD = [
    'function rebuildParts(flat) {',
    '  var c = flat.coords, k = 0, out = [];',
    '  for (var i = 0; i < flat.meta.length; i++) {',
    '    var m = flat.meta[i], rings = [];',
    '    for (var r = 0; r < m.rings.length; r++) {',
    '      var n = m.rings[r], ring = new Array(n);',
    '      for (var q = 0; q < n; q++) { ring[q] = [c[k], c[k + 1]]; k += 2; }',
    '      rings.push(ring);',
    '    }',
    '    out.push({ id: m.id, name: m.name, union: m.union, rings: rings });',
    '  }',
    '  return out;',
    '}'
  ].join('\n');

  var GLUE = [
    REBUILD,
    'self.onmessage = function (e) {',
    '  var d = e.data, best = null;',
    '  var parts = rebuildParts(d.flat);',
    '  d.flat = null;',
    '  var orders = MXNest.orderings(parts, d.total);',
    '  for (var i = d.from; i < d.to && i < orders.length; i++) {',
    '    var r = MXNest.nestOnce(parts, orders[i], d.opt, null);',
    '    if (!r) continue;',
    '    if (!best || r.failed.length < best.failed.length ||',
    '       (r.failed.length === best.failed.length && r.length < best.length)) best = r;',
    '    self.postMessage({ progress: 1 });',
    '  }',
    '  self.postMessage({ done: true, result: best });',
    '};'
  ].join('\n');

  /* Les contours ne sont plus recopiés dans chaque ouvrier : ils partent une
     seule fois, à plat, dans un tableau de nombres transféré (et non cloné).
     Une copie complète du kit par ouvrier, c'est ce qui saturait la mémoire du
     panneau et le faisait tuer en fin de calcul, sans message d'erreur. */
  function flattenParts(list) {
    var xs = [], meta = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i], ringsMeta = [];
      for (var r = 0; r < p.rings.length; r++) {
        var ring = p.rings[r];
        ringsMeta.push(ring.length);
        for (var q = 0; q < ring.length; q++) { xs.push(ring[q][0]); xs.push(ring[q][1]); }
      }
      meta.push({ id: p.id, name: p.name, union: !!p.union, rings: ringsMeta });
    }
    return { coords: new Float64Array(xs), meta: meta };
  }


  function runParallel(list, opt, total, onProgress, done) {
    workerSource(function (src) {
      if (!src) { done(null); return; }
      var n = 4;
      try { n = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)); } catch (e) {}
      if (list.length > 60) n = Math.min(n, 2);
      if (total < n) n = Math.max(1, total);

      var url, workers = [], best = null, finished = 0, seen = 0, failed = false;
      try {
        url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      } catch (e2) { done(null); return; }

      function stopAll() {
        for (var q = 0; q < workers.length; q++) { try { workers[q].terminate(); } catch (e4) {} }
        try { URL.revokeObjectURL(url); } catch (e6) {}
      }

      var per = Math.ceil(total / n);
      for (var w = 0; w < n; w++) {
        var from = w * per, to = Math.min(total, from + per);
        if (from >= to) break;
        var wk;
        try { wk = new Worker(url); } catch (e3) { failed = true; break; }
        workers.push(wk);
        wk.onerror = function () {
          if (failed) return;
          failed = true;
          stopAll();
          done(best);            // on rend ce qui a été trouvé, jamais rien
        };
        wk.onmessage = function (ev) {
          if (failed) return;
          var msg = ev.data;
          if (msg.progress) { seen++; if (seen % 4 === 0 || seen === total) onProgress(seen, total); return; }
          if (msg.done) {
            var r = msg.result;
            if (r && (!best || r.length < best.length)) { best = r; onProgress(seen, total, best); }
            finished++;
            if (finished >= workers.length) { stopAll(); done(best); }
          }
        };
        /* un exemplaire des contours par ouvrier, mais TRANSFÉRÉ : le tableau
           change de propriétaire au lieu d'être dupliqué. */
        var flat = flattenParts(list);
        wk.postMessage({ flat: flat, opt: opt, total: total, from: from, to: to },
                       [flat.coords.buffer]);
      }
      if (failed || !workers.length) { stopAll(); done(best); }
    });
  }

  function options() {
    var rot = $('rot').value;
    var o = {
      sheetWidth: parseFloat($('sheet').value) || 1350,
      gap: (function () {
        var g = parseFloat($('gap').value) || 0;
        var b = parseFloat($('bleed').value) || 0;
        /* Chaque pièce déborde de b : deux voisines doivent donc s'écarter de
           2b en plus, sinon un fond perdu s'imprime sur la découpe de l'autre. */
        if (b > 0 && $('bleedgap').checked) g += 2 * b;
        return g;
      })(),
      edgeMargin: parseFloat($('edge').value) || 0,
      resolution: parseFloat($('prec').value) || 1,
      angleStep: rot === '0' ? -1 : parseFloat(rot),
      candidates: 24,
      angleTries: 10,
      fillHoles: $('holes').checked,
      smallPx: 120000,      // seuil « petite pièce » : elle balaie toute la planche
      scanFine: 8,
      maxLength: (parseFloat($('maxlen').value) > 0 ? parseFloat($('maxlen').value) : 60000),
      cornerGuard: !!($('graphtec') && $('graphtec').checked),
      cornerGuardSize: parseFloat($('gsize') && $('gsize').value) || 25
    };
    o.xStep = o.resolution >= 1 ? 6 : 4;
    return o;
  }

  /* Coins Graphtec : V10 les bloque dès le départ en haut ; ici on libère ce
     qui reste (coins bas, et TOUT plan venu de Sparrow, qui ne les connaît
     pas). Le moteur choisit la solution la plus courte. */
  function applyCornerGuard(r, opt) {
    if (!r || !opt || !opt.cornerGuard) return r;
    var L0 = r.length;
    try {
      var rep = MXNest.guardCorners(r, parts, opt);
      if (rep && (rep.moved || rep.grown || rep.stuck || rep.flipped)) {
        log('Coins Graphtec (' + opt.cornerGuardSize + ' mm) : ' +
            (rep.flipped ? 'plan retourné de 180°, ' : '') +
            (rep.moved ? rep.moved + ' pièce(s) déplacée(s), ' : '') +
            'planche ' + (L0 / 1000).toFixed(3) + ' → ' + (r.length / 1000).toFixed(3) + ' m' +
            (rep.stuck ? ' — ' + rep.stuck + ' pièce(s) encore dans un coin, à vérifier' : '') + '.');
      }
    } catch (eG) { log('Coins Graphtec : vérification impossible (' + eG.message + ').'); }
    r._cornerGrown = !!(r && typeof L0 === 'number' && r.length > L0 + 0.5);
    return r;
  }

  /* Reprise de la place perdue aux coins, en tâche de fond.
     Quand libérer les coins a dû allonger la planche (plan serré jusque dans
     les angles, typiquement Sparrow), on fait tourner l'affinage de V10 — qui
     bloque les coins — sur une copie de travail, par petits paquets pour que
     le panneau reste vivant. Toutes les trois fournées, on revérifie les
     quatre coins sur un clone ; on ne garde qu'un plan plus court ET aux coins
     libres. Le plan affiché est toujours valide ; Stop garde le meilleur. */
  var refining = false, unlockAfterRefine = false;
  function clonePlan(r) {
    return { placements: r.placements.slice(0), failed: r.failed || [], length: r.length,
             partArea: r.partArea, sheetWidth: r.sheetWidth, fill: r.fill, hybridSource: r.hybridSource };
  }
  function refineCorners(plan, opt, done) {
    if (!plan || !opt.cornerGuard || !plan._cornerGrown) { done(plan); return; }
    var effort = parseInt($('effort').value, 10) || 16;
    var budget = effort >= 100 ? 30000 : effort >= 16 ? 15000 : 8000;
    var t0 = Date.now(), best = plan, work = clonePlan(plan), chunk = 0, seed = 777, start = plan.length;
    refining = true;
    (function step() {
      var left = Math.max(0, Math.round((budget - (Date.now() - t0)) / 1000));
      if (cancelled || Date.now() - t0 > budget) { return end(); }
      hint('Coins Graphtec : on reprend la place perdue… ' + (best.length / 1000).toFixed(3) + ' m (encore ' + left + ' s)');
      try { MXNest.ruinRecreate(work, parts, opt, 4, seed++); } catch (e) { return end(); }
      if (++chunk % 3 === 0) {
        var c = clonePlan(work), rp = null;
        try { rp = MXNest.guardCorners(c, parts, opt); } catch (e2) { rp = null; }
        if (rp && !rp.stuck && c.length < best.length - 0.01) {
          best = c; result = best; setResult(best); draw(best);
        }
      }
      setTimeout(step, 0);
    })();
    function end() {
      refining = false;
      if (best.length < start - 0.01) {
        log('Coins Graphtec : ' + ((start - best.length)).toFixed(0) + ' mm repris après libération des coins → ' +
            (best.length / 1000).toFixed(3) + ' m.');
      }
      done(best);
      if (unlockAfterRefine) { unlockAfterRefine = false; lock(false); }
    }
  }

  $('mode').addEventListener('change', function () {
    $('namesrow').style.display = this.value === 'spot' ? '' : 'none';
    if (this.value === 'color') hint(T('msg.selcolor', null, 'Sélectionne un contour de coupe dans Illustrator, puis Analyser.'));
  });

  // ---------- analyse ----------
  $('scan').addEventListener('click', function () {
    lock(true);
    hint(T('msg.reading', null, 'Lecture du document…'));
    call('mxnsScan', [$('mode').value, $('cutnames').value,
                      $('selonly').checked ? 'true' : 'false',
                      $('regroup').checked ? 'true' : 'false',
                      $('tight').checked ? 'true' : 'false'], function (txt) {
      var lines = txt.split('\n');
      if (lines[0].indexOf('ERR') === 0) { hint(lines[0].split('\t')[1], 'err'); lock(false); return; }
      var list = [], cur = null, stat = null;
      session = '';
      for (var i = 1; i < lines.length; i++) {
        var f = lines[i].split('\t');
        if (f[0] === 'SESSION') session = f[1];
        else if (f[0] === 'P') { cur = { id: f[1], name: f[2], src: f[3], union: f[4] === '1', rings: [] }; list.push(cur); }
        else if (f[0] === 'R' && cur) {
          var pts = f[1].split(' '), ring = [];
          for (var k = 0; k < pts.length; k++) {
            var xy = pts[k].split(',');
            ring.push([parseFloat(xy[0]), parseFloat(xy[1])]);
          }
          if (ring.length > 2) cur.rings.push(ring);
        } else if (f[0] === 'END') stat = f;
      }
      for (var j = list.length - 1; j >= 0; j--) if (!list[j].rings.length) list.splice(j, 1);
      parts = list;
      result = null;
      fillResults = [null, null, null];
      setResult(null);
      draw(null);
      if (!parts.length) hint(T('msg.none', null, 'Aucune pièce trouvée — essaie « Que contient le fichier ? »'), 'err');
      else hint(T('msg.ready', { n: parts.length }, parts.length + ' pièces prêtes.'));
      if (stat) log('Analyse : ' + stat[1] + ' pièces, ' + stat[2] + ' ignorés, ' + stat[3] + ' regroupés · ' +
                    stat[4] + ' masque, ' + stat[5] + ' silhouette, ' + stat[6] + ' boîte.');
      lock(false);
    });
  });

  $('diag').addEventListener('click', function () {
    lock(true);
    call('mxnsDiag', [], function (txt) {
      var lines = txt.split('\n'), out = [];
      for (var i = 0; i < lines.length; i++) {
        var f = lines[i].split('\t');
        if (f[0] === 'TOTAL') out.push(f[1] + ' tracés');
        if (f[0] === 'SPOT') out.push('ton direct : ' + f[1]);
        if (f[0] === 'COL') out.push(f[1] + ' × ' + f[2]);
      }
      log(out.join('\n'));
      hint('Contenu listé ci-dessous.');
      lock(false);
    });
  });

  // ---------- imbrication ----------
  $('run').addEventListener('click', function () {
    if (!parts.length || busy) return;
    lock(true);
    cancelled = false;
    $('stop').disabled = false;
    var opt = options();
    var tries = parseInt($('effort').value, 10) || 12;
    // plus on se donne d'essais, plus on fouille finement à chaque essai
    if (tries >= 100) { opt.angleTries = 14; opt.xStep = 3; opt.candidates = 30; }
    else if (tries >= 16) { opt.angleTries = 12; opt.xStep = 4; opt.candidates = 24; }
    else { opt.angleTries = 8; opt.xStep = 6; opt.candidates = 16; }
    var t0 = Date.now();
    var best = null, pairsMade = 0;

    function runSequential(list, done) {
      var orders = MXNest.orderings(list, tries), i = 0, b = null;
      (function step() {
        if (cancelled) { log('Recherche interrompue à l\'essai ' + i + '/' + orders.length + '.'); done(b); return; }
        if (i >= orders.length) { done(b); return; }
        hint(T('msg.search', { i: i + 1, n: orders.length }, 'Recherche ' + (i + 1) + '/' + orders.length + '…'));
        var r = null;
        try { r = MXNest.nestOnce(list, orders[i], opt, null); } catch (eRun) { r = null; }
        if (r && (!b || r.failed.length < b.failed.length ||
                 (r.failed.length === b.failed.length && r.length < b.length))) {
          b = r;
          result = b;                 // applicable immédiatement, sans attendre la fin
          setResult(b);
          draw(b);
          $('apply').disabled = false;
        }
        i++;
        setTimeout(step, 0);
      })();
    }

    function runList(list, done) {
      runSequential(list, done);
      return;
      /* eslint-disable no-unreachable */
      runParallel(list, opt, tries, function (seen, tot, cur) {
        hint('Recherche ' + seen + '/' + tot + ' (calcul réparti sur plusieurs cœurs)…');
        if (cur) { setResult(cur); draw(cur); }
      }, function (b) {
        if (b) { done(b); return; }
        hint(T('msg.single', null, 'Calcul sur un seul cœur…'));
        runSequential(list, done);
      });
    }

    runList(parts, function (plain) {
      best = plain;
      if (!$('pairs').checked || parts.length < 2 || parts.length > 60) return refine(finish);
      hint('Essai d\'emboîtement par paires…');
      setTimeout(function () {
        try {
          var resP = MXNest.safeResolution(parts, opt);
          var pr = MXNest.buildPairs(parts, opt, resP, Math.round(opt.gap * resP), 24);
          if (!pr.made) return finish();
          runList(pr.parts, function (withPairs) {
            if (withPairs && best && withPairs.length < best.length - 0.5) { best = withPairs; pairsMade = pr.made; }
            refine(finish);
          });
        } catch (e) { refine(finish); }
      }, 0);
    });

    /* Affinage : on démolit et on repose quelques pièces, par paquets, pour que
       le panneau reste vivant et que l'aperçu suive. Chaque paquet ne peut que
       raccourcir le plan, jamais l'allonger. */
    function refine(done) {
      var total = !$('refine').checked ? 0 : (tries >= 100 ? 1200 : 400);
      if (!total || !best || best.placements.length < 4) { done(); return; }
      var doneRounds = 0;
      (function step() {
        if (cancelled || doneRounds >= total) { done(); return; }
        hint(T('msg.refining', { i: doneRounds, n: total }, 'Affinage ' + doneRounds + '/' + total + '…'));
        try {
          /* graine tirée au hasard à chaque paquet : l'affinage ne paie qu'une
             fois sur sept environ, autant multiplier les tirages. Il ne peut
             jamais rallonger le plan, seulement le raccourcir. */
          MXNest.ruinRecreate(best, parts, opt, 50, Math.floor(Math.random() * 2000000000));
          result = best;
          setResult(best);
          draw(best);
        } catch (e) { done(); return; }
        doneRounds += 50;
        setTimeout(step, 0);
      })();
    }

    function finish() {
      if (!best) { best = result; }
      best = applyCornerGuard(best, opt);
      if (best && best._cornerGrown && !cancelled) {
        result = best; setResult(best); draw(best);
        refineCorners(best, opt, function (b2) { best = b2; best._cornerGrown = false; finish2(); });
        return;
      }
      finish2();
    }
    function finish2() {
      result = best;
      fillResults = [null, null, null];
      if (!result) { hint(T('msg.noplan', null, 'Aucun plan trouvé.'), 'err'); lock(false); return; }
      setResult(best);
      draw(best);
      var bad = -1;
      try {
        /* sur un très gros kit, la vérification coûte autant qu'un essai :
           on la saute plutôt que de risquer de perdre le résultat. */
        if (best && best.placements.length <= 120) bad = MXNest.verify(best, opt);
      } catch (e) { bad = -1; }
      var s = ((Date.now() - t0) / 1000).toFixed(1);
      log('Imbrication : ' + best.placements.length + ' pièces, ' + (best.length / 1000).toFixed(3) + ' m, ' +
          (best.fill * 100).toFixed(1) + ' % en ' + s + ' s' +
          (pairsMade ? ' · ' + pairsMade + ' couple(s) retenus' : '') +
          (bad === 0 ? ' · aucun contact' : bad > 0 ? ' · ' + bad + ' CONTACT' : ''));
      var nf = best.failed ? best.failed.length : 0;
      $('stop').disabled = true;
      hint(nf > 0 ? T('msg.unplaced', { n: nf }, nf + ' pièce(s) non placée(s) : planche trop courte ou pièce plus large que la laize.')
         : bad > 0 ? T('msg.contact', { n: bad }, bad + ' pièce(s) en contact — écart lame trop faible.')
         : T('msg.done', { s: s }, 'Terminé en ' + s + ' s.'),
           (nf > 0 || bad > 0) ? 'warn' : null);
      lock(false);
    }
  });

  function setResult(r) {
    $('wid').textContent = (parseFloat($('sheet').value) || 1350) + ' mm';
    if (!r) {
      $('len').textContent = '—'; $('fill').textContent = '—'; $('waste').textContent = '—';
      var g0 = $('gauge');
      if (g0) { g0.className = 'gauge'; g0.firstChild.style.width = '0'; }
      $('result').className = 'result';
      return;
    }
    $('len').textContent = (r.length / 1000).toFixed(3).replace('.', ',');
    var pct = r.fill * 100;
    $('fill').textContent = pct.toFixed(1).replace('.', ',') + ' %';
    var g = $('gauge');
    if (g) {
      g.className = 'gauge ' + (pct >= 70 ? 'good' : 'mid');
      g.firstChild.style.width = Math.max(2, Math.min(100, pct)) + '%';
    }
    var surf = r.length * r.sheetWidth / 1e6;
    if (!r.sheetWidth) surf = r.length * (parseFloat($('sheet').value) || 1350) / 1e6;
    $('waste').textContent = (surf - r.partArea / 1e6).toFixed(2).replace('.', ',') + ' m²';
    $('result').className = 'result done';
  }

  // ---------- aperçu ----------
  /* Dix teintes au lieu de six, réparties sur le cercle : sur une planche de
     quarante pièces, deux voisines de même couleur se confondaient. */
  var PAL = ['#ff5a1f', '#4aa3df', '#57c98a', '#f0b429', '#a97bd6', '#4fc3bd',
             '#e8615f', '#7aa63c', '#5d7fc9', '#d98cc0'];

  function draw(r) {
    var cv = $('preview'), ctx = cv.getContext('2d');
    var sw = parseFloat($('sheet').value) || 1350;
    var len = r ? Math.max(r.length, 100) : sw * 0.5;

    /* L'aperçu tenait toute la largeur et laissait la hauteur filer : sur une
       planche longue, il débordait ; en panneau large, il restait riquiqui avec
       du vide autour. On le met maintenant à l'échelle des DEUX dimensions
       disponibles, en gardant les proportions de la planche — ce qu'on voit
       correspond donc vraiment au rapport laize/métrage. */
    var host = cv.parentNode;
    var availW = (host && host.clientWidth ? host.clientWidth : 380) - 2;
    var top = 0;
    try { top = cv.getBoundingClientRect().top; } catch (e) { top = 200; }
    var availH = Math.max(160, (window.innerHeight || 900) - top - 70);
    if (availW < 60) availW = 380;

    var scale = Math.min(availW / sw, availH / len);
    if (!isFinite(scale) || scale <= 0) scale = availW / sw;

    cv.width = Math.max(60, Math.round(sw * scale));
    cv.height = Math.max(40, Math.round(len * scale));
    ctx.fillStyle = '#1c1c1c';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!r) return;
    var shapes = r.placements;
    for (var fs = 0; fs < 3; fs++) if (fillResults[fs]) shapes = shapes.concat(fillResults[fs].placements);
    for (var p = 0; p < shapes.length; p++) {
      var P = shapes[p], src = P.part, isSticker = P.scale !== undefined;
      if (!src) continue;
      var rings = [];
      for (var k = 0; k < src.rings.length; k++) rings.push(MXNest.rotatePoly(src.rings[k], P.angle * Math.PI / 180));
      var bb = MXNest.bboxOf(rings);
      var dx = P.x - bb[0], dy = P.y - bb[1];
      ctx.beginPath();
      for (var i = 0; i < rings.length; i++) {
        for (var q = 0; q < rings[i].length; q++) {
          var X = (rings[i][q][0] + dx) * scale, Y = (rings[i][q][1] + dy) * scale;
          if (q === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        }
        ctx.closePath();
      }
      ctx.fillStyle = isSticker ? '#9a9a9a' : PAL[p % PAL.length];
      ctx.globalAlpha = isSticker ? 0.45 : 0.6;
      ctx.fill(src.union ? 'nonzero' : 'evenodd');
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if ($('graphtec') && $('graphtec').checked) {
      var gz = (parseFloat($('gsize').value) || 25) * scale;
      ctx.strokeStyle = '#ff5a1f';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, gz, gz);
      ctx.strokeRect(cv.width - gz - 0.5, 0.5, gz, gz);
      ctx.strokeRect(0.5, cv.height - gz - 0.5, gz, gz);
      ctx.strokeRect(cv.width - gz - 0.5, cv.height - gz - 0.5, gz, gz);
      ctx.setLineDash([]);
    }
  }

  // ---------- application ----------
  $('apply').addEventListener('click', function () {
    if (!result || busy) return;

    /* Garde-fou : un plan doit contenir AUTANT de pièces que l'analyse en a
       trouvées. Si ce n'est pas le cas, les pièces manquantes resteraient où
       elles sont dans le document — donc potentiellement sous une autre pièce,
       sans que rien ne le signale. On préfère refuser et le dire. */
    if (result.placements.length !== parts.length) {
      var manque = parts.length - result.placements.length;
      hint(manque + ' pièce(s) absente(s) du plan sur ' + parts.length +
           ' — rien n\'a été appliqué. Relance le calcul, et préviens-moi si ça se répète.', 'err');
      log('REFUSÉ : plan incomplet, ' + result.placements.length + '/' + parts.length + ' pièces.');
      return;
    }

    lock(true);
    hint('Application…');
    var rows = [];
    for (var i = 0; i < result.placements.length; i++) {
      var P = result.placements[i];
      rows.push(P.part.id + ',' + P.angle + ',' + P.x.toFixed(2) + ',' + P.y.toFixed(2));
    }
    call('mxnsApply', [rows.join(';'), String(parseFloat($('sheet').value) || 1350),
                       String(result.length), $('fitab').checked ? 'true' : 'false', session], function (txt) {
      var f = txt.split('\t');
      if (f[0] !== 'OK') hint(f[1] || txt, 'err');
      else {
        hint(T('msg.applied', { n: f[1], miss: f[2] > 0 ? T('msg.miss', { n: f[2] }, ' — ' + f[2] + ' introuvable(s)') : '' },
             f[1] + ' pièce(s) placées' + (f[2] > 0 ? ' — ' + f[2] + ' introuvable(s)' : '') + '. Ctrl+Z annule.'));
        log('Appliqué : ' + f[1] + ' pièces sur ' + (result.length / 1000).toFixed(3) + ' m.');
      }
      lock(false);
    });
  });

  $('marks').addEventListener('click', function () {
    if (busy) return;
    lock(true);
    call('mxnsMarks', [$('markd').value, $('marki').value, 'Regmark', 'false',
                       $('mshape').value, $('markw').value], function (txt) {
      var f = txt.split('\t');
      if (f[0] !== 'OK') hint(f[1] || txt, 'err');
      else {
        hint(T('msg.marks', { n: f[1], warn: f[2] > 0 ? T('msg.markswarn', { n: f[2] }, ' — ATTENTION, ' + f[2] + ' repère(s) recouvert(s) par une pièce.') : '.' },
             f[1] + ' repère(s) posé(s) sur le calque Regmark' +
             (f[2] > 0 ? ' — ATTENTION, ' + f[2] + ' repère(s) recouvert(s) par une pièce.' : '.')),
             f[2] > 0 ? 'warn' : null);
        log('Repères : ' + f[1] + ' posés, ' + f[2] + ' recouverts.');
      }
      lock(false);
    });
  });

  /* Presets machine. Seules deux valeurs sont documentées : les ronds de 10 mm
     relevés sur les planches de l'atelier, et les angles Graphtec (manuel
     CE7000 : taille 5 à 20 mm, trait 0,3 à 1,0 mm, ligne unique). Pour les
     autres machines, rien n'est deviné : tu règles une fois et tu mémorises. */
  /* Deux préréglages seulement sont documentés :
       - Valiani : ronds de 10 mm, mesurés sur des planches de production
       - Graphtec CE7000 / FC9000 : angles en L. Le manuel autorise une taille de
         5 à 20 mm et un trait de 0,3 à 1,0 mm, et impose une ligne unique ;
         on prend le maximum, le plus précis sur une grande planche.
     Les autres machines sont laissées vides : un repère de la mauvaise taille
     ne se voit qu'une fois la planche imprimée. Tu règles une fois d'après un
     fichier validé, puis tu mémorises. */
  var PRESETS = {
    valiani:  { shape: 'circle', size: 10, inset: 10, line: 1 },
    graphtec: { shape: 'corner', size: 20, inset: 15, line: 1 }
  };
  try {
    var saved = window.localStorage.getItem('mxns_presets');
    if (saved) {
      var extra = JSON.parse(saved);
      for (var kk in extra) if (extra.hasOwnProperty(kk)) PRESETS[kk] = extra[kk];
    }
  } catch (ePr) { }

  function loadPreset(name) {
    var p = PRESETS[name];
    if (!p) {
      hint(T('msg.nopreset', null, 'Aucune cote connue pour cette machine : règle la forme, la taille et le retrait d\'après un fichier validé, puis clique Mémoriser.'));
      return;
    }
    $('mshape').value = p.shape;
    $('markd').value = p.size;
    $('marki').value = p.inset;
    $('markw').value = p.line;
  }
  $('mpreset').addEventListener('change', function () { loadPreset(this.value); });
  loadPreset('valiani');

  $('msave').addEventListener('click', function () {
    var name = $('mpreset').value;
    PRESETS[name] = { shape: $('mshape').value, size: parseFloat($('markd').value),
                      inset: parseFloat($('marki').value), line: parseFloat($('markw').value) };
    try {
      window.localStorage.setItem('mxns_presets', JSON.stringify(PRESETS));
      hint(T('msg.saved', { name: name }, 'Réglage de repères mémorisé pour « ' + name + ' ».'));
    } catch (eS) { hint('Mémorisation impossible sur cette installation.', 'warn'); }
  });

  $('lang').value = I18N.get();
  I18N.apply();
  $('lang').addEventListener('change', function () {
    I18N.set(this.value);
    hint(T('msg.start', null, 'Ouvre ton kit, puis analyse le document.'));
  });

  /* Surveillance du document actif.
     Chaque document garde son analyse, son plan et ses stickers. Changer
     d'onglet échange ce que montre le panneau — SAUF pendant un calcul : la
     recherche continue en fond pour le document où elle a été lancée, et
     l'échange se fait dès qu'elle se termine. Rien n'est jeté. */
  function saveDocState(key) {
    if (key === null) return;
    docStates[key] = { parts: parts, result: result, session: session, fillResults: fillResults };
  }
  function loadDocState(key) {
    var st = docStates[key];
    parts = st ? st.parts : [];
    result = st ? st.result : null;
    session = st ? st.session : '';
    fillResults = st ? st.fillResults : [null, null, null];
    setResult(result);
    draw(result);
    lock(false);
  }
  var busyNoted = '';
  function watchDocument() {
    call('mxnsPing', [], function (txt) {
      var f = txt.split('\t');
      if (f[0] !== 'OK') return;
      var name = f[3] || '', key = name + '|' + (f[4] || '');
      var head = f[1] + ' ' + String(f[2]).split(' ')[0] + ' · ' + name;
      if (docKey === null) { docKey = key; docName = name; $('hostinfo').textContent = head; return; }
      if (key === docKey) { busyNoted = ''; $('hostinfo').textContent = head; return; }
      if (busy) {
        $('hostinfo').textContent = head + ' — calcul en cours sur « ' + docName + ' »';
        if (busyNoted !== key) {
          busyNoted = key;
          log('Onglet « ' + name + ' » : la recherche continue sur « ' + docName +
              ' ». Le nesting de cet onglet sera libre à la fin.');
        }
        return;
      }
      busyNoted = '';
      saveDocState(docKey);
      var had = docStates[key], prev = docName;
      docKey = key; docName = name;
      $('hostinfo').textContent = head;
      loadDocState(key);
      if (had && (had.parts.length || had.result)) {
        hint('« ' + name + ' » : ' + had.parts.length + ' pièce(s)' +
             (had.result ? ', plan de ' + (had.result.length / 1000).toFixed(3) + ' m retrouvé.' : ' analysées.'));
      } else {
        hint(T('msg.start', null, 'Ouvre ton kit, puis analyse le document.'));
      }
      log('Onglet : « ' + prev + ' » → « ' + name + ' »' + (had ? ' (état retrouvé).' : '.'));
    });
  }
  setInterval(watchDocument, 2500);

  /* ---------- fond perdu ----------
     On agrandit le MASQUE d'écrêtage de la pièce, pas son tracé de coupe : la
     coupe reste où elle est, et le dessin déborde derrière. Le décalage est
     calculé avec Clipper, en arrondi, donc les angles rentrants ne se croisent
     pas — ce qu'un simple agrandissement à l'échelle aurait fait. */
  $('dobleed').addEventListener('click', function () {
    if (busy) return;
    var mm = parseFloat($('bleed').value) || 0;
    if (mm <= 0) { hint(T('msg.bleed0', null, 'Mets une valeur de décalage supérieure à 0.'), 'warn'); return; }
    if (typeof ClipperLib === 'undefined') { hint('Clipper absent du panneau.', 'err'); return; }
    var mode = $('bleedmode').value;

    lock(true);
    hint(T('msg.bleedscanning', null, 'Lecture des contours sélectionnés…'));

    /* Chemin direct : on lit ce qui est sélectionné MAINTENANT, on décale, on
       applique dans le même ordre. Aucun identifiant, aucune étiquette, aucune
       dépendance à l'analyse du nesting — c'est là que ça cassait sur les
       pièces venues d'un PDF. */
    call('mxnsGetCuts', [$('cutnames').value, '0.08'], function (txt) {
      var lines = txt.split('\n');
      if (lines[0].indexOf('ERR') === 0) { hint(lines[0].split('\t')[1], 'err'); lock(false); return; }

      var items = [], cur = null, surSel = false, stats = null;
      for (var i = 1; i < lines.length; i++) {
        var f = lines[i].split('\t');
        if (f[0] === 'SEL') surSel = (f[1] === '1');
        else if (f[0] === 'P') { cur = { idx: parseInt(f[1], 10), rings: [] }; items.push(cur); }
        else if (f[0] === 'R' && cur) {
          var pts = f[1].split(' '), ring = [];
          for (var k = 0; k < pts.length; k++) {
            var xy = pts[k].split(',');
            ring.push([parseFloat(xy[0]), parseFloat(xy[1])]);
          }
          if (ring.length > 2) cur.rings.push(ring);
        } else if (f[0] === 'END') stats = f;
      }

      var S = 10000, rows = [], traitees = 0, sansContour = 0;
      for (var p2 = 0; p2 < items.length; p2++) {
        var it = items[p2];
        if (!it.rings.length) { sansContour++; continue; }
        var co = new ClipperLib.ClipperOffset(2, 0.25 * S);
        for (var r2 = 0; r2 < it.rings.length; r2++) {
          var src = it.rings[r2], path = [];
          for (var q2 = 0; q2 < src.length; q2++) {
            path.push({ X: Math.round(src[q2][0] * S), Y: Math.round(src[q2][1] * S) });
          }
          co.AddPath(path, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
        }
        var sol = new ClipperLib.Paths();
        co.Execute(sol, mm * S);
        if (!sol.length) { sansContour++; continue; }

        var cl = new ClipperLib.Clipper();
        cl.AddPaths(sol, ClipperLib.PolyType.ptSubject, true);
        var out = new ClipperLib.Paths();
        cl.Execute(ClipperLib.ClipType.ctUnion, out,
                   ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
        if (!out.length) out = sol;

        /* on ne garde que le contour extérieur : c'est lui le masque */
        var best = 0, bestA = -1;
        for (var o2 = 0; o2 < out.length; o2++) {
          var a = Math.abs(ClipperLib.Clipper.Area(out[o2]));
          if (a > bestA) { bestA = a; best = o2; }
        }
        var buf = [];
        for (var z2 = 0; z2 < out[best].length; z2++) {
          buf.push((out[best][z2].X / S).toFixed(2) + ',' + (out[best][z2].Y / S).toFixed(2));
        }
        rows.push(it.idx + '|' + buf.join(' '));
        traitees++;
      }

      if (!rows.length) {
        hint(T('msg.bleednone', null,
               'Aucun contour exploitable' + (surSel ? ' dans la sélection.' : ' dans le document.')), 'warn');
        log('Décalage : rien à traiter' + (stats ? ' (' + stats[1] + ' objets examinés)' : '') + '.');
        lock(false);
        return;
      }

      call('mxnsApplyOffset', [rows.join(';'), (mode === 'mask' ? 'mask' : 'cut'), $('cutnames').value],
        function (t2) {
          var g = t2.split('\t');
          if (g[0] !== 'OK') { hint(g[1] || t2, 'err'); lock(false); return; }
          var crees = parseInt(g[1] || '0', 10), remplaces = parseInt(g[2] || '0', 10), rates = parseInt(g[3] || '0', 10);
          var msg = (mode === 'mask')
            ? (crees + remplaces) + ' masque(s) à +' + mm + ' mm' + (crees ? ' (' + crees + ' créé(s))' : '')
            : crees + ' tracé(s) de coupe à +' + mm + ' mm';
          msg += (g[4] === '1') ? ' (sélection).' : ' (tout le document).';
          if (rates) msg += ' ' + rates + ' échec(s).';
          if (sansContour) msg += ' ' + sansContour + ' sans contour.';
          hint(msg, (rates || sansContour) ? 'warn' : null);
          log('Décalage : ' + msg);
          parts = [];
          result = null;
          session = '';
          setResult(null);
          draw(null);
          lock(false);
        });
    });
  });

  /* Remise à zéro complète : le panneau ET Illustrator. Les références
     d'objets et les étiquettes posées dans les notes survivaient à tout, si
     bien que la seule issue était de redémarrer Illustrator. */
  $('reset').addEventListener('click', function () {
    lock(true);
    call('mxnsReset', [], function (txt) {
      var f = txt.split('\t');
      parts = [];
      result = null;
      session = '';
      fillResults = [null, null, null];
      docStates = {};
      setResult(null);
      draw(null);
      $('log').textContent = '';
      hint(T('msg.reset', { n: f[1] || 0 },
             'Tout est remis à zéro' + (f[0] === 'OK' ? ' — ' + (f[1] || 0) + ' étiquette(s) retirée(s) du document.' : '.')));
      lock(false);
      call('mxnsPing', [], function (t2) {
        var g = t2.split('\t');
        if (g[0] === 'OK') {
          docKey = (g[3] || '') + '|' + (g[4] || ''); docName = g[3] || '';
          $('hostinfo').textContent = g[1] + ' ' + String(g[2]).split(' ')[0] + ' · ' + g[3];
        }
      });
    });
  });

  /* ---------- stop ----------
     Une recherche maximale dure une minute et demie. Sans bouton d'arrêt, la
     seule issue était d'attendre. Le plan déjà trouvé est conservé : on arrête
     la recherche, on ne jette pas le résultat. */
  $('stop').addEventListener('click', function () {
    if (!busy) return;
    cancelled = true;
    $('stop').disabled = true;
    hint(T('msg.stopping', null, 'Arrêt demandé — on garde le meilleur plan trouvé.'), 'warn');
    log('Arrêt demandé.');
  });

  /* Repli des blocs : replié par défaut, l'état est mémorisé pour chacun. */
  function foldable(secId, headId, key) {
    var sec = $(secId), head = $(headId);
    if (!sec || !head) return;
    try { if (window.localStorage.getItem(key) === 'open') sec.classList.remove('folded'); } catch (e) { }
    head.addEventListener('click', function () {
      sec.classList.toggle('folded');
      try { window.localStorage.setItem(key, sec.classList.contains('folded') ? 'closed' : 'open'); } catch (e2) { }
      draw(result);
    });
  }
  foldable('finitions', 'finitions-head', 'mxns_finitions');
  foldable('encres', 'encres-head', 'mxns_encres');

  /* ---------- gestionnaire d'encres ----------
     Sur le modèle de l'Ink Manager d'Esko : toutes les encres utilisées, avec
     pour chacune une cible — et un seul bouton qui applique toutes les
     conversions d'un coup. */
  var inks = [];
  /* séparateurs visibles : un caractère de contrôle pourrait être abîmé au
     passage entre le panneau et Illustrator */
  var SEP1 = '|;|', SEP2 = '|>|';

  function inkColor(cm) {
    var m = /^(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(cm || '');
    if (m) {
      var C = +m[1] / 100, M = +m[2] / 100, Y = +m[3] / 100, K = +m[4] / 100;
      return 'rgb(' + Math.round(255 * (1 - C) * (1 - K)) + ',' + Math.round(255 * (1 - M) * (1 - K)) +
             ',' + Math.round(255 * (1 - Y) * (1 - K)) + ')';
    }
    var r = /^rgb(\d+)\/(\d+)\/(\d+)$/.exec(cm || '');
    if (r) return 'rgb(' + r[1] + ',' + r[2] + ',' + r[3] + ')';
    return '#888';
  }

  function renderInks() {
    var box = $('inktable');
    box.innerHTML = '';
    var spotNames = [];
    for (var i = 0; i < inks.length; i++) if (inks[i].kind === 'ton direct') spotNames.push(inks[i].name);

    for (var k = 0; k < inks.length; k++) {
      (function (ink) {
        var row = document.createElement('div');
        row.className = 'inkrow' + (ink.used ? '' : ' unused');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.addEventListener('change', function () { ink.checked = cb.checked; });

        var sw = document.createElement('span');
        sw.className = 'inkswatch';
        sw.style.background = inkColor(ink.cmyk);

        var nm = document.createElement('span');
        nm.className = 'inkname';
        nm.textContent = ink.name;
        nm.title = ink.cmyk ? 'CMJN ' + ink.cmyk : '';

        var kd = document.createElement('span');
        kd.className = 'inkkind';
        kd.textContent = ink.kind;

        var ct = document.createElement('span');
        ct.className = 'inkcount';
        ct.textContent = ink.used ? ink.count + ' obj.' : 'inutilisée';

        /* La cible : seuls les tons directs se convertissent. Les encres quadri
           sont des canaux d'un mélange, pas des couleurs isolables : on les
           montre et on peut sélectionner leurs objets, comme chez Esko. */
        var sel = document.createElement('select');
        var keep = document.createElement('option');
        keep.value = ''; keep.textContent = '— inchangée';
        sel.appendChild(keep);
        if (ink.kind === 'ton direct') {
          var q = document.createElement('option');
          q.value = '__CMYK__'; q.textContent = '→ quadri (CMJN)';
          sel.appendChild(q);
          for (var n = 0; n < spotNames.length; n++) {
            if (spotNames[n] === ink.name) continue;
            var o = document.createElement('option');
            o.value = spotNames[n]; o.textContent = '→ ' + spotNames[n];
            sel.appendChild(o);
          }
        } else {
          sel.disabled = true;
          sel.title = 'Une encre quadri ne se convertit pas seule : sélectionne ses objets et recolore-les.';
        }
        sel.value = ink.target || '';
        sel.addEventListener('change', function () {
          ink.target = sel.value;
          row.classList.toggle('changed', !!sel.value);
        });

        row.appendChild(cb); row.appendChild(sw); row.appendChild(nm);
        row.appendChild(kd); row.appendChild(ct); row.appendChild(sel);
        box.appendChild(row);
      })(inks[k]);
    }
  }

  function loadInks(after) {
    call('mxnsInkList', [], function (txt) {
      var lines = txt.split('\n');
      if (lines[0].indexOf('ERR') === 0) { hint(lines[0].split('\t')[1], 'err'); if (after) after(); return; }
      inks = [];
      var surSel = false;
      for (var i = 1; i < lines.length; i++) {
        var f = lines[i].split('\t');
        if (f[0] === 'SEL') surSel = f[1] === '1';
        if (f[0] === 'INK') inks.push({ name: f[1], count: parseInt(f[2], 10) || 0, kind: f[3],
                                        cmyk: f[4] || '', used: f[5] === '1', target: '', checked: false });
      }
      /* quadri d'abord, puis les tons directs utilisés du plus fréquent au
         moins fréquent, puis les inutilisés */
      var rank = function (x) { return x.kind === 'quadri' ? 0 : x.kind === 'rvb' ? 1 : x.used ? 2 : 3; };
      inks.sort(function (a, b) { return rank(a) - rank(b) || b.count - a.count; });
      renderInks();
      var nbU = 0;
      for (var u = 0; u < inks.length; u++) if (inks[u].used) nbU++;
      hint(nbU + ' encre(s) utilisée(s)' + (surSel ? ' dans la sélection' : ' dans le document') +
           (inks.length > nbU ? ', ' + (inks.length - nbU) + ' inutilisée(s) au nuancier.' : '.'));
      if (after) after();
    });
  }

  function checkedInks() {
    var out = [];
    for (var i = 0; i < inks.length; i++) if (inks[i].checked) out.push(inks[i]);
    return out;
  }

  $('inklist').addEventListener('click', function () { if (!busy) loadInks(); });

  $('inkselect').addEventListener('click', function () {
    if (busy) return;
    var c = checkedInks();
    if (!c.length) { hint('Coche au moins une encre.', 'warn'); return; }
    var names = [];
    for (var i = 0; i < c.length; i++) names.push(c[i].name);
    lock(true);
    call('mxnsInkSelect', [names.join(SEP1)], function (txt) {
      var f = txt.split('\t');
      lock(false);
      if (f[0] !== 'OK') { hint(f[1] || txt, 'err'); return; }
      hint(f[1] + ' objet(s) sélectionné(s) portant ' + names.join(', ') + '.');
    });
  });

  $('inkapply').addEventListener('click', function () {
    if (busy) return;
    var pairs = [], resume = [];
    for (var i = 0; i < inks.length; i++) {
      if (inks[i].target) {
        pairs.push(inks[i].name + SEP2 + inks[i].target);
        resume.push(inks[i].name + ' → ' + (inks[i].target === '__CMYK__' ? 'quadri' : inks[i].target));
      }
    }
    if (!pairs.length) { hint('Choisis ce que devient au moins une encre.', 'warn'); return; }
    lock(true);
    call('mxnsInkApply', [pairs.join(SEP1)], function (txt) {
      lock(false);
      var lines = txt.split('\n');
      if (lines[0].indexOf('ERR') === 0) { hint(lines[0].split('\t')[1], 'err'); return; }
      var total = 0, surSel = false;
      for (var k = 1; k < lines.length; k++) {
        var f = lines[k].split('\t');
        if (f[0] === 'TOTAL') total = parseInt(f[1], 10) || 0;
        if (f[0] === 'SEL') surSel = f[1] === '1';
      }
      log('Encres : ' + resume.join(' · ') + ' — ' + total + ' usage(s) convertis' +
          (surSel ? ' (sélection).' : ' (document).'));
      loadInks(function () {
        hint(resume.length + ' conversion(s) appliquée(s) en un passage, ' + total + ' usage(s) modifié(s).');
      });
    });
  });

  $('inkrename').addEventListener('click', function () {
    if (busy) return;
    var c = checkedInks();
    if (c.length !== 1) { hint('Coche une seule encre à renommer.', 'warn'); return; }
    var nn = $('inknew').value;
    lock(true);
    call('mxnsInkRename', [c[0].name, nn], function (txt) {
      var f = txt.split('\t');
      lock(false);
      if (f[0] !== 'OK') { hint(f[1] || txt, 'err'); return; }
      log('Encres : « ' + c[0].name + ' » renommé en « ' + f[1] + ' ».');
      loadInks(function () { hint('« ' + c[0].name + ' » s\'appelle maintenant « ' + f[1] + ' ».'); });
    });
  });

  /* ================= remplissage par stickers ================= */
  foldable('stickers', 'stickers-head', 'mxns_stickers');
  foldable('profils', 'profils-head', 'mxns_profils');

  function anyFiller() { return !!(fillers[0] || fillers[1] || fillers[2]); }
  function dropFillResults() { fillResults = [null, null, null]; draw(result); lock(busy); }

  function fillerCfg(slot, cap) {
    var scales = [1];
    if ($('fmode' + slot).value === 'free') {
      var mn = (parseFloat($('fmin' + slot).value) || 100) / 100;
      var mx = (parseFloat($('fmax' + slot).value) || 100) / 100;
      if (mn > mx) { var t = mn; mn = mx; mx = t; }
      var n = Math.max(1, Math.round(parseFloat($('fsteps').value) || 6));
      scales = [];
      if (n === 1) scales.push(mx);
      else for (var i = 0; i < n; i++) scales.push(mx - (mx - mn) * i / (n - 1));
    }
    var step = parseFloat($('frot').value) || 0, angles = [0];
    if (step > 0) { angles = []; for (var a = 0; a < 360; a += step) angles.push(a); }
    return { scales: scales, angles: angles, maxCount: cap };
  }

  function fillerText(slot) {
    var f = fillers[slot - 1];
    if (!f) return T('msg.fnone', null, 'Aucun sticker chargé.');
    var from = f.doc ? ' — pris dans « ' + f.doc + ' »' : '';
    if ($('fmode' + slot).value === 'free') {
      var mn = (parseFloat($('fmin' + slot).value) || 100) / 100, mx = (parseFloat($('fmax' + slot).value) || 100) / 100;
      if (mn > mx) { var t = mn; mn = mx; mx = t; }
      return '« ' + f.name + ' » : ' + (f.w * mn).toFixed(0) + ' à ' + (f.w * mx).toFixed(0) + ' mm de large' + from;
    }
    return '« ' + f.name + ' » : ' + f.w.toFixed(0) + ' × ' + f.h.toFixed(0) + ' mm' + from;
  }

  [1, 2, 3].forEach(function (slot) {
    function refresh() {
      var free = $('fmode' + slot).value === 'free';
      $('fmin' + slot).disabled = !free; $('fmax' + slot).disabled = !free;
      $('fhint' + slot).textContent = fillerText(slot);
    }
    $('fmode' + slot).addEventListener('change', function () { refresh(); dropFillResults(); });
    $('fmin' + slot).addEventListener('change', function () { refresh(); dropFillResults(); });
    $('fmax' + slot).addEventListener('change', function () { refresh(); dropFillResults(); });
    $('fcount' + slot).addEventListener('change', dropFillResults);
    $('fpick' + slot).addEventListener('click', function () {
      if (busy) return;
      lock(true);
      call('mxnsFillerPick', [String(slot), $('tight').checked ? 'true' : 'false'], function (txt) {
        var lines = txt.split('\n'), h = $('fhint' + slot);
        if (lines[0].indexOf('ERR') === 0) {
          h.textContent = lines[0].split('\t')[1] || txt; h.className = 'hint err';
          lock(false); return;
        }
        var f = null, rings = [];
        for (var i = 1; i < lines.length; i++) {
          var c = lines[i].split('\t');
          if (c[0] === 'F') f = { name: c[2] || 'sticker', src: c[3], union: c[4] === '1', doc: c[7] || '' };
          else if (c[0] === 'R') {
            var pts = c[1].split(' '), ring = [];
            for (var k = 0; k < pts.length; k++) { var xy = pts[k].split(','); ring.push([parseFloat(xy[0]), parseFloat(xy[1])]); }
            if (ring.length > 2) rings.push(ring);
          }
        }
        if (!f || !rings.length) { h.textContent = 'Contour du sticker introuvable.'; h.className = 'hint err'; lock(false); return; }
        /* contours ramenés à l'origine : l'échelle et la rotation travaillent
           sur la forme, pas sur sa position dans le document */
        var bb = MXNest.bboxOf(rings);
        for (var r = 0; r < rings.length; r++) for (var q = 0; q < rings[r].length; q++) { rings[r][q][0] -= bb[0]; rings[r][q][1] -= bb[1]; }
        fillers[slot - 1] = { name: f.name, rings: rings, union: f.union, doc: f.doc,
                              w: bb[2] - bb[0], h: bb[3] - bb[1] };
        h.className = 'hint';
        refresh();
        log('Sticker ' + slot + ' : « ' + f.name + ' », ' + (bb[2] - bb[0]).toFixed(1) + ' × ' +
            (bb[3] - bb[1]).toFixed(1) + ' mm (empreinte ' + f.src + ', document « ' + f.doc + ' »).');
        fillResults = [null, null, null];
        lock(false);
      });
    });
  });
  $('frot').addEventListener('change', dropFillResults);
  $('fsteps').addEventListener('change', dropFillResults);

  /* Semis à tour de rôle : chaque modèle pose un petit paquet, puis passe la
     main au suivant, sur la même feuille. Semés l'un après l'autre, deux
     modèles de même taille donnaient tout au premier et rien au second. */
  function fillRoundRobin(base, slots) {
    var BATCH = 6, out = [null, null, null], left = {}, i;
    for (i = 0; i < slots.length; i++) left[slots[i].slot] = slots[i].cap;
    var active = slots.slice(0);
    while (active.length) {
      var next = [];
      for (i = 0; i < active.length; i++) {
        var sl = active[i], o = null;
        try { o = MXNest.scanFiller(base, sl.filler, fillerCfg(sl.slot, Math.min(BATCH, left[sl.slot]))); } catch (e) { o = null; }
        if (o && o.count) {
          var acc = out[sl.slot - 1] || (out[sl.slot - 1] = { placements: [], area: 0, count: 0 });
          acc.placements = acc.placements.concat(o.placements); acc.area += o.area; acc.count += o.count;
          left[sl.slot] -= o.count;
          if (left[sl.slot] > 0) next.push(sl);
        }
      }
      active = next;
    }
    return out;
  }

  $('ffill').addEventListener('click', function () {
    if (busy || !result || !anyFiller()) return;
    lock(true);
    hint('Remplissage des vides…');
    setTimeout(function () {
      var opt = options(), t0 = Date.now(), base = null;
      try { base = MXNest.buildFillBase(result, parts, opt); } catch (eB) { base = null; }
      var slots = [];
      for (var s = 1; s <= 3; s++) {
        var cap = Math.round(parseFloat($('fcount' + s).value) || 0);
        if (fillers[s - 1] && cap > 0) slots.push({ slot: s, filler: fillers[s - 1], cap: cap });
      }
      fillResults = base && slots.length ? fillRoundRobin(base, slots) : [null, null, null];
      var n = 0, area = 0, detail = [];
      for (var d = 0; d < 3; d++) { var fr = fillResults[d]; detail.push(fr ? fr.count : 0); if (fr) { n += fr.count; area += fr.area; } }
      draw(result);
      if (!n) {
        hint('Aucune place pour ces stickers : essaie plus petit, plus d\'angles, ou un écart de lame plus faible.', 'warn');
        lock(false); return;
      }
      var fill = (result.partArea + area) / (result.length * opt.sheetWidth);
      $('fill').textContent = (fill * 100).toFixed(1).replace('.', ',') + ' %';
      hint(n + ' sticker(s) prévus (' + detail.join(' + ') + ') — remplissage ' +
           (fill * 100).toFixed(1).replace('.', ',') + ' %, planche inchangée. Clique « Poser les stickers ».');
      log('Remplissage : ' + n + ' stickers (' + detail.join(' + ') + '), +' + (area / 1e6).toFixed(3) +
          ' m², ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s.');
      lock(false);
    }, 0);
  });

  $('fapply').addEventListener('click', function () {
    if (busy || !(fillResults[0] || fillResults[1] || fillResults[2])) return;
    var rows = [];
    for (var s = 1; s <= 3; s++) {
      var fr = fillResults[s - 1];
      if (!fr) continue;
      for (var i = 0; i < fr.placements.length; i++) {
        var P = fr.placements[i];
        rows.push(s + ',' + P.angle + ',' + (P.scale * 100).toFixed(4) + ',' + P.x.toFixed(2) + ',' + P.y.toFixed(2));
      }
    }
    lock(true);
    /* on ne pose que dans le document du plan : sinon les stickers
       partiraient dans le fichier où l'on est allé chercher le modèle */
    call('mxnsPing', [], function (pt) {
      var g = pt.split('\t');
      if (g[0] !== 'OK' || ((g[3] || '') + '|' + (g[4] || '')) !== docKey) {
        hint('Reviens sur « ' + docName + ' » pour poser ses stickers.', 'warn');
        lock(false); return;
      }
      hint('Pose des stickers…');
      call('mxnsApplyFillers', [rows.join(';')], function (txt) {
        var f = txt.split('\t');
        if (f[0] !== 'OK') hint(f[1] || txt, 'err');
        else {
          var dead = parseInt(f[2] || '0', 10);
          hint(f[1] + ' sticker(s) posés sur le calque MXN_STICKERS. Ctrl+Z annule.' +
               (dead ? ' ' + dead + ' copie(s) sans modèle : le document du sticker a été fermé ?' : ''), dead ? 'warn' : null);
          log('Stickers posés : ' + f[1] + (f[3] ? ' — ' + f[3] : '') + '.');
        }
        lock(false);
      });
    });
  });

  $('fclear').addEventListener('click', function () {
    if (busy) return;
    lock(true);
    call('mxnsClearFillers', [], function (txt) {
      var f = txt.split('\t');
      hint(f[0] === 'OK' ? (f[1] || 0) + ' sticker(s) retiré(s).' : (f[1] || txt), f[0] === 'OK' ? null : 'err');
      lock(false);
    });
  });

  $('graphtec').addEventListener('change', function () { $('gsize').disabled = !this.checked; draw(result); });
  $('gsize').addEventListener('change', function () { draw(result); });

  /* ================= réglages retrouvés + profils ================= */
  var SETTINGS = ['sheet', 'gap', 'edge', 'maxlen', 'rot', 'prec', 'effort', 'sptime', 'mode', 'cutnames',
    'refine', 'pairs', 'holes', 'regroup', 'tight', 'selonly', 'fitab', 'graphtec', 'gsize',
    'mpreset', 'mshape', 'markd', 'marki', 'markw', 'bleed', 'bleedmode', 'bleedgap',
    'frot', 'fsteps', 'fmode1', 'fmin1', 'fmax1', 'fcount1', 'fmode2', 'fmin2', 'fmax2', 'fcount2',
    'fmode3', 'fmin3', 'fmax3', 'fcount3'];

  function collectSettings() {
    var o = {};
    SETTINGS.forEach(function (id) { var el = $(id); if (el) o[id] = el.type === 'checkbox' ? el.checked : el.value; });
    return o;
  }
  function fire(id) {
    var el = $(id); if (!el) return;
    var ev = document.createEvent('Event'); ev.initEvent('change', true, true); el.dispatchEvent(ev);
  }
  var applyingSettings = false;
  function applySettings(o) {
    if (!o) return;
    applyingSettings = true;
    SETTINGS.forEach(function (id) {
      var el = $(id); if (!el || !(id in o)) return;
      if (el.type === 'checkbox') el.checked = !!o[id]; else el.value = o[id];
    });
    ['mode', 'graphtec', 'fmode1', 'fmode2', 'fmode3'].forEach(fire);
    applyingSettings = false;
    saveSettings();
    setResult(result);
    draw(result);
  }
  function saveSettings() {
    if (applyingSettings) return;
    try { window.localStorage.setItem('mxns_settings', JSON.stringify(collectSettings())); } catch (e) { }
  }
  SETTINGS.forEach(function (id) {
    var el = $(id); if (!el) return;
    el.addEventListener('change', saveSettings);
    if (el.tagName === 'INPUT' && el.type !== 'checkbox') el.addEventListener('input', saveSettings);
  });

  function profiles() { try { return JSON.parse(window.localStorage.getItem('mxns_profiles') || '{}'); } catch (e) { return {}; } }
  function saveProfiles(p) { try { window.localStorage.setItem('mxns_profiles', JSON.stringify(p)); } catch (e) { } }
  function curProfile(name) {
    try { if (name === undefined) return window.localStorage.getItem('mxns_profile_cur') || '';
          window.localStorage.setItem('mxns_profile_cur', name); } catch (e) { }
    $('profcur').textContent = name ? '· ' + name : '';
    return name;
  }
  function refreshProfiles(sel) {
    var p = profiles(), box = $('profsel'), names = [], k;
    for (k in p) if (p.hasOwnProperty(k)) names.push(k);
    names.sort();
    box.innerHTML = '';
    var o0 = document.createElement('option'); o0.value = ''; o0.textContent = names.length ? '—' : '(aucun)'; box.appendChild(o0);
    names.forEach(function (n) { var o = document.createElement('option'); o.value = n; o.textContent = n; box.appendChild(o); });
    box.value = sel && p[sel] ? sel : '';
  }
  $('profsel').addEventListener('change', function () { $('profname').value = this.value; });
  /* choisir un profil dans la liste le charge directement : c'est ce qu'on
     veut en passant d'une surface d'impression à l'autre */
  $('profsel').addEventListener('change', function () {
    if (!this.value || busy) return;
    var p = profiles()[this.value]; if (!p) return;
    applySettings(p); curProfile(this.value);
    hint('Profil « ' + this.value + ' » chargé.');
  });
  $('profload').addEventListener('click', function () {
    var n = $('profsel').value; if (!n) { hint('Choisis un profil.', 'warn'); return; }
    applySettings(profiles()[n]); curProfile(n); hint('Profil « ' + n + ' » chargé.');
  });
  $('profsave').addEventListener('click', function () {
    var n = ($('profname').value || $('profsel').value || '').replace(/^\s+|\s+$/g, '');
    if (!n) { hint('Donne un nom au profil.', 'warn'); return; }
    var p = profiles(); p[n] = collectSettings(); saveProfiles(p);
    refreshProfiles(n); curProfile(n); hint('Profil « ' + n + ' » enregistré.');
  });
  $('profren').addEventListener('click', function () {
    var old = $('profsel').value, n = ($('profname').value || '').replace(/^\s+|\s+$/g, '');
    if (!old || !n || n === old) { hint('Choisis un profil, tape le nouveau nom, puis Renommer.', 'warn'); return; }
    var p = profiles(); p[n] = p[old]; delete p[old]; saveProfiles(p);
    refreshProfiles(n); if (curProfile() === old) curProfile(n); hint('« ' + old + ' » renommé en « ' + n + ' ».');
  });
  $('profdel').addEventListener('click', function () {
    var n = $('profsel').value; if (!n) return;
    var p = profiles(); delete p[n]; saveProfiles(p);
    refreshProfiles(); if (curProfile() === n) curProfile(''); $('profname').value = '';
    hint('Profil « ' + n + ' » supprimé.');
  });

  refreshProfiles(curProfile());
  curProfile(curProfile());
  try { var savedSet = window.localStorage.getItem('mxns_settings'); if (savedSet) applySettings(JSON.parse(savedSet)); } catch (eSet) { }
  $('gsize').disabled = !$('graphtec').checked;
  [1, 2, 3].forEach(function (sl) { $('fhint' + sl).textContent = fillerText(sl); });

  window.addEventListener('resize', function () { draw(result); });
  call('mxnsPing', [], function (txt) {
    var f = txt.split('\t');
    $('hostinfo').textContent = f[0] === 'OK' ? f[1] + ' ' + String(f[2]).split(' ')[0] + ' · ' + f[3] : 'hôte indisponible';
    if (f[0] === 'OK') { docKey = (f[3] || '') + '|' + (f[4] || ''); docName = f[3] || ''; }
  });
  draw(null);
  lock(false);

  // API publique minimale pour le moteur hybride V10 + Sparrow.
  // Le nesting historique reste inchangé : le bouton hybride injecte simplement
  // un autre candidat dans le même résultat que le bouton Appliquer consomme.
  window.MXNestSpirit = {
    /* Le pont Sparrow tourne dans son propre fichier : il ne voit pas la
       variable d'arrêt du panneau, il doit la DEMANDER. Cette fonction
       manquait — d'où un Stop qui marchait sur V10, qui lit la variable en
       direct, et restait sans effet sur Sparrow. */
    isCancelled: function () { return cancelled; },
    resetCancel: function () { cancelled = false; },
    getParts: function () { return parts; },
    getResult: function () { return result; },
    getOptions: function () { return options(); },
    setExternalResult: function (r) {
      var o = options();
      r = applyCornerGuard(r, o);
      fillResults = [null, null, null];
      result = r;
      setResult(r);
      draw(r);
      $('apply').disabled = !r;
      if (r && r._cornerGrown && !cancelled) {
        refineCorners(r, o, function (b2) {
          b2._cornerGrown = false; result = b2; setResult(b2); draw(b2);
          hint('Planche prête : ' + (b2.length / 1000).toFixed(3) + ' m, coins Graphtec libres.');
        });
      }
    },
    setBusy: function (v) {
      /* le pont Sparrow libère le panneau juste après avoir remis son plan :
         si la reprise des coins tourne encore, on attend qu'elle finisse */
      if (!v && refining) { unlockAfterRefine = true; return; }
      lock(!!v);
    },
    log: log,
    hint: hint,
    draw: draw
  };
})();
