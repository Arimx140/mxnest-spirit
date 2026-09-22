/* MXNestSpirit — moteur d'imbrication true-shape.
 * Même code que le script Illustrator, exécuté ici par Chrome : 30 à 50 fois plus rapide.
 */
var MXNest = (function () {
  function newArr(n, v) { var a = new Array(n); for (var i = 0; i < n; i++) a[i] = v; return a; }

  function rotatePoly(poly, rad) {
    var c = Math.cos(rad), s = Math.sin(rad), out = new Array(poly.length);
    for (var i = 0; i < poly.length; i++) {
      var p = poly[i];
      out[i] = [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
    }
    return out;
  }

  function bboxOf(rings) {
    var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      for (var i = 0; i < ring.length; i++) {
        var p = ring[i];
        if (p[0] < x0) x0 = p[0];
        if (p[0] > x1) x1 = p[0];
        if (p[1] < y0) y0 = p[1];
        if (p[1] > y1) y1 = p[1];
      }
    }
    return [x0, y0, x1, y1];
  }

  function polyArea(ring) {
    var a = 0;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      a += (ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]);
    }
    return Math.abs(a) / 2;
  }

  function pointInRing(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // surface nette en pair-impair : indépendant du sens de tracé
  function netArea(part) {
    if (part._area !== undefined) return part._area;
    var rings = part.rings;
    if (rings.length === 1) { part._area = polyArea(rings[0]); return part._area; }
    var a = 0;
    for (var i = 0; i < rings.length; i++) {
      var pt = rings[i][0], depth = 0;
      for (var j = 0; j < rings.length; j++) {
        if (i !== j && pointInRing(pt[0], pt[1], rings[j])) depth++;
      }
      a += (depth % 2 ? -1 : 1) * polyArea(rings[i]);
    }
    part._area = Math.abs(a);
    return part._area;
  }

  /* --- rastérisation directe en bits : 32 pixels par opération --- */
  function rangeMask(a, b) {                 // bits a..b allumés dans un mot
    var m = 0xFFFFFFFF << a;
    if (b < 31) m &= (0xFFFFFFFF >>> (31 - b));
    return m;
  }

  function rasterPacked(rings, res, ox, oy, w, h) {
    var words = ((w + 31) >> 5) + 1;
    var bits = newArr(words * h, 0);
    var top = newArr(w, -1), bot = newArr(w, -1);
    var rowFirst = newArr(h, -1), rowLast = newArr(h, -1);
    var buckets = new Array(h), b;
    for (b = 0; b < h; b++) buckets[b] = null;

    var r, i, j, ring;
    for (r = 0; r < rings.length; r++) {
      ring = rings[r];
      for (i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var ax = (ring[j][0] - ox) * res, ay = (ring[j][1] - oy) * res;
        var bx = (ring[i][0] - ox) * res, by = (ring[i][1] - oy) * res;
        markEdgeBits(bits, words, w, h, ax, ay, bx, by, rowFirst, rowLast);
        if (ay === by) continue;
        var y0 = Math.floor(Math.min(ay, by) - 0.5), y1 = Math.ceil(Math.max(ay, by) + 0.5);
        if (y0 < 0) y0 = 0;
        if (y1 > h - 1) y1 = h - 1;
        for (var y = y0; y <= y1; y++) {
          if (!buckets[y]) buckets[y] = [];
          buckets[y].push(ax, ay, bx, by);
        }
      }
    }

    for (var yy = 0; yy < h; yy++) {
      var list = buckets[yy];
      buckets[yy] = null;
      if (!list) continue;
      var cy = yy + 0.5, xs = [];
      for (var k = 0; k < list.length; k += 4) {
        var ya = list[k + 1], yb = list[k + 3];
        if ((cy >= ya && cy < yb) || (cy >= yb && cy < ya)) {
          xs.push(list[k] + (cy - ya) / (yb - ya) * (list[k + 2] - list[k]));
        }
      }
      if (xs.length < 2) continue;
      xs.sort(function (A, B) { return A - B; });
      var base = yy * words;
      for (var q = 0; q + 1 < xs.length; q += 2) {
        var sx = Math.floor(xs[q] + 0.5), ex = Math.ceil(xs[q + 1] - 0.5);
        if (sx < 0) sx = 0;
        if (ex > w - 1) ex = w - 1;
        if (ex < sx) continue;
        var w0 = sx >> 5, w1 = ex >> 5;
        if (w0 === w1) bits[base + w0] |= rangeMask(sx & 31, ex & 31);
        else {
          bits[base + w0] |= rangeMask(sx & 31, 31);
          for (var jj = w0 + 1; jj < w1; jj++) bits[base + jj] = -1;
          bits[base + w1] |= rangeMask(0, ex & 31);
        }
        if (rowFirst[yy] < 0 || w0 < rowFirst[yy]) rowFirst[yy] = w0;
        if (w1 > rowLast[yy]) rowLast[yy] = w1;
        for (var x = sx; x <= ex; x++) {
          if (top[x] < 0) top[x] = yy;
          bot[x] = yy;
        }
      }
    }
    return { w: w, h: h, words: words, bits: bits, top: top, bot: bot,
             rowFirst: rowFirst, rowLast: rowLast };
  }

  function markEdgeBits(bits, words, w, h, ax, ay, bx, by, rowFirst, rowLast) {
    var dx = bx - ax, dy = by - ay;
    var n = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))) + 1;
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var x = Math.floor(ax + dx * t), y = Math.floor(ay + dy * t);
      if (x < 0 || x >= w || y < 0 || y >= h) continue;
      var wi = x >> 5;
      bits[y * words + wi] |= (1 << (x & 31));
      if (rowFirst[y] < 0 || wi < rowFirst[y]) rowFirst[y] = wi;
      if (wi > rowLast[y]) rowLast[y] = wi;
    }
  }

  /* dilatation directe sur les bits (octogone) : l'écart de lame sans repasser par une grille */
  function dilateBits(src, r) {
    var words = src.words, h = src.h, cur = src.bits;
    for (var step = 0; step < r; step++) {
      var diag = (step % 2 === 1);
      var out = newArr(words * h, 0);
      for (var y = 0; y < h; y++) {
        var base = y * words;
        var up = y > 0 ? base - words : -1;
        var dn = y < h - 1 ? base + words : -1;
        for (var j = 0; j < words; j++) {
          var v = cur[base + j];
          var lo = j > 0 ? cur[base + j - 1] : 0;
          var hi = j < words - 1 ? cur[base + j + 1] : 0;
          var o = v | (v << 1) | (lo >>> 31) | (v >>> 1) | (hi << 31);
          if (up >= 0) {
            var u = cur[up + j];
            o |= u;
            if (diag) o |= (u << 1) | ((up > 0 && j > 0 ? cur[up + j - 1] : 0) >>> 31) |
                          (u >>> 1) | ((j < words - 1 ? cur[up + j + 1] : 0) << 31);
          }
          if (dn >= 0) {
            var dd = cur[dn + j];
            o |= dd;
            if (diag) o |= (dd << 1) | ((j > 0 ? cur[dn + j - 1] : 0) >>> 31) |
                          (dd >>> 1) | ((j < words - 1 ? cur[dn + j + 1] : 0) << 31);
          }
          out[base + j] = o;
        }
      }
      cur = out;
    }
    var rf = newArr(h, -1), rl = newArr(h, -1);
    for (var y2 = 0; y2 < h; y2++) {
      var b2 = y2 * words;
      for (var j2 = 0; j2 < words; j2++) {
        if (cur[b2 + j2]) { if (rf[y2] < 0) rf[y2] = j2; rl[y2] = j2; }
      }
    }
    return { w: src.w, h: h, words: words, bits: cur, rowFirst: rf, rowLast: rl };
  }

  function orBits(dst, src) {
    for (var i = 0; i < src.bits.length; i++) dst.bits[i] |= src.bits[i];
    for (var y = 0; y < dst.h; y++) {
      if (src.rowFirst[y] >= 0 && (dst.rowFirst[y] < 0 || src.rowFirst[y] < dst.rowFirst[y])) dst.rowFirst[y] = src.rowFirst[y];
      if (src.rowLast[y] > dst.rowLast[y]) dst.rowLast[y] = src.rowLast[y];
    }
    for (var c = 0; c < dst.w; c++) {
      if (src.top[c] >= 0 && (dst.top[c] < 0 || src.top[c] < dst.top[c])) dst.top[c] = src.top[c];
      if (src.bot[c] > dst.bot[c]) dst.bot[c] = src.bot[c];
    }
  }

  function makeMask(rings, res, gapPx, union) {
    var bb = bboxOf(rings), pad = gapPx + 2;
    var ox = bb[0] - pad / res, oy = bb[1] - pad / res;
    var w = Math.ceil((bb[2] - bb[0]) * res) + 2 * pad + 2;
    var h = Math.ceil((bb[3] - bb[1]) * res) + 2 * pad + 2;
    var m;
    if (union && rings.length > 1) {          // réunion des formes : rien ne s'annule
      m = rasterPacked([rings[0]], res, ox, oy, w, h);
      for (var u = 1; u < rings.length; u++) orBits(m, rasterPacked([rings[u]], res, ox, oy, w, h));
    } else {
      m = rasterPacked(rings, res, ox, oy, w, h);
    }
    m.offX = ox; m.offY = oy; m.bbox = bb; m.gapPx = gapPx; m.dilated = null;
    return m;
  }

  function dilatedOf(mask) {
    if (!mask.dilated) mask.dilated = mask.gapPx > 0 ? dilateBits(mask, mask.gapPx) : mask;
    return mask.dilated;
  }

  /* --- feuille --- */
  function Sheet(w, h) {
    this.w = w; this.h = h;
    this.words = ((w + 31) >> 5) + 1;
    this.bits = newArr(this.words * h, 0);
    this.front = newArr(w, 0);
    this.pad = 0; this.usable = w;
    this.used = 0;
    this.hasHoles = false;
    this.deepScan = false;
    this.cap = 0;
  }

  Sheet.prototype.walls = function (y0, y1) {
    var pad = this.pad, usable = this.usable, x;
    for (var y = y0; y < y1; y++) {
      var base = y * this.words;
      for (x = 0; x < pad; x++) this.bits[base + (x >> 5)] |= (1 << (x & 31));
      for (x = pad + usable; x < this.w; x++) this.bits[base + (x >> 5)] |= (1 << (x & 31));
      if (y < pad) for (x = 0; x < this.w; x++) this.bits[base + (x >> 5)] |= (1 << (x & 31));
    }
  };

  Sheet.prototype.setBorders = function (pad, usable) {
    this.pad = pad; this.usable = usable;
    this.walls(0, this.h);
    for (var c = 0; c < this.w; c++) this.front[c] = pad;
  };

  Sheet.prototype.grow = function (newH) {
    if (this.cap && newH > this.cap) newH = this.cap;     // planche bridée : on ne dépasse pas
    if (newH <= this.h) return;
    var old = this.h, add = (newH - old) * this.words;
    for (var i = 0; i < add; i++) this.bits.push(0);
    this.h = newH;
    if (this.pad) this.walls(old, newH);
  };

  /* Bloque un rectangle de pixels, une fois pour toutes : sert à réserver les
     coins de la planche aux repères de découpe (option Graphtec). */
  Sheet.prototype.blockBox = function (x0, y0, x1, y1) {
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 > this.w) x1 = this.w; if (y1 > this.h) y1 = this.h;
    for (var y = y0; y < y1; y++) {
      var base = y * this.words;
      for (var x = x0; x < x1; x++) this.bits[base + (x >> 5)] |= (1 << (x & 31));
    }
  };

  Sheet.prototype.hit = function (m, ox, oy) {
    if (ox < 0 || oy < 0 || ox + m.w > this.w || oy + m.h > this.h) return true;
    var s = ox & 31, off = ox >> 5, sw = this.words, mw = m.words;
    var bits = this.bits, mb = m.bits;
    for (var r = 0; r < m.h; r++) {
      var f = m.rowFirst[r];
      if (f < 0) continue;
      var l = m.rowLast[r], rowBase = (oy + r) * sw, mBase = r * mw;
      for (var j = f; j <= l; j++) {
        var v = mb[mBase + j];
        if (!v) continue;
        var idx = rowBase + off + j;
        if (bits[idx] & (v << s)) return true;
        if (s && (bits[idx + 1] & (v >>> (32 - s)))) return true;
      }
    }
    return false;
  };

  Sheet.prototype.stamp = function (m, ox, oy) {
    var s = ox & 31, off = ox >> 5, sw = this.words, mw = m.words;
    for (var r = 0; r < m.h; r++) {
      var f = m.rowFirst[r];
      if (f < 0) continue;
      var l = m.rowLast[r], rowBase = (oy + r) * sw, mBase = r * mw;
      for (var j = f; j <= l; j++) {
        var v = m.bits[mBase + j];
        if (!v) continue;
        var idx = rowBase + off + j;
        this.bits[idx] |= (v << s);
        if (s) this.bits[idx + 1] |= (v >>> (32 - s));
      }
    }
  };

  Sheet.prototype.updateFront = function (m, ox, oy) {
    for (var c = 0; c < m.w; c++) {
      var last = m.bot[c];
      if (last < 0) continue;
      var col = ox + c, v = oy + last + 1;
      if (col >= 0 && col < this.w && v > this.front[col]) this.front[col] = v;
      if (v > this.used) this.used = v;
    }
  };

  Sheet.prototype.restY = function (m, ox) {
    var best = 0;
    for (var c = 0; c < m.w; c++) {
      var t = m.top[c];
      if (t < 0) continue;
      var y = this.front[ox + c] - t;
      if (y > best) best = y;
    }
    return best;
  };

  /* ---------- coins réservés (option Graphtec) ----------
     Un carré de côté g (25 mm par défaut) à chaque coin du plan de travail
     reste vide : c'est là que la machine lit ses repères d'angle. Mesuré depuis
     le bord du plan de travail, marge comprise. En pixels de feuille, la zone
     utile commence à la marge : le carré y mesure donc g - marge. */
  function cornerPx(opt, res) {
    var g = opt.cornerGuardSize > 0 ? opt.cornerGuardSize : 25;
    return Math.max(0, Math.round((g - (opt.edgeMargin || 0)) * res));
  }
  /* Les deux coins HAUTS sont connus dès le départ : y = 0 ne bouge jamais. */
  function guardTopCorners(sheet, pad, usable, opt, res) {
    if (!opt.cornerGuard) return;
    var c = cornerPx(opt, res);
    if (c <= 0) return;
    sheet.blockBox(pad, pad, pad + c, pad + c);
    sheet.blockBox(pad + usable - c, pad, pad + usable, pad + c);
  }
  /* Les quatre coins, pour une planche de longueur connue (mm, marges comprises). */
  function blockAllCorners(sheet, pad, usable, opt, res, lengthMm) {
    var c = cornerPx(opt, res);
    if (c <= 0) return;
    var bot = Math.round((lengthMm - 2 * (opt.edgeMargin || 0)) * res) + pad;
    if (bot + 2 > sheet.h) sheet.grow(bot + 2);
    sheet.blockBox(pad, pad, pad + c, pad + c);
    sheet.blockBox(pad + usable - c, pad, pad + usable, pad + c);
    var b0 = Math.max(pad, bot - c);
    sheet.blockBox(pad, b0, pad + c, bot);
    sheet.blockBox(pad + usable - c, b0, pad + usable, bot);
  }

  function slide(sheet, m, x0) {
    var y = sheet.restY(m, x0);
    if (y + m.h > sheet.h) sheet.grow(y + m.h + 128);
    var guard = 0;
    while (sheet.hit(m, x0, y)) {
      y++;
      if (y + m.h > sheet.h) sheet.grow(y + m.h + 128);
      if (guard++ > 3000) return null;
    }
    var x = x0, moved = true, loops = 0;
    while (moved && loops++ < 40) {
      moved = false;
      while (y > 0 && !sheet.hit(m, x, y - 1)) { y--; moved = true; }
      while (x > 0 && !sheet.hit(m, x - 1, y)) { x--; moved = true; }
    }
    return { x: x, y: y };
  }

  // on essaie d'abord les angles qui donnent la boîte la plus compacte : aucun calcul d'image
  function shortlistAngles(part, angles, keep) {
    if (angles.length <= keep) return angles;
    var scored = [];
    for (var i = 0; i < angles.length; i++) {
      var rad = angles[i] * Math.PI / 180, rings = [];
      for (var k = 0; k < part.rings.length; k++) rings.push(rotatePoly(part.rings[k], rad));
      var b = bboxOf(rings);
      scored.push({ a: angles[i], s: (b[3] - b[1]) * 1000 + (b[2] - b[0]) });
    }
    scored.sort(function (A, B) { return A.s - B.s; });
    var out = [];
    for (var j = 0; j < keep && j < scored.length; j++) out.push(scored[j].a);
    return out;
  }

  function popcount(v) {
    v = v - ((v >> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
    return (((v + (v >> 4)) & 0x0F0F0F0F) * 0x01010101) >> 24;
  }

  /* Surface de contact avec ce qui est déjà posé : à hauteur égale, une pièce
     qui épouse ses voisines laisse moins de vide qu'une pièce qui les frôle. */
  function contactAt(sheet, cm, ox, oy) {
    if (ox < 0 || oy < 0 || ox + cm.w > sheet.w || oy + cm.h > sheet.h) return 0;
    var s = ox & 31, off = ox >> 5, sw = sheet.words, mw = cm.words, n = 0;
    for (var r = 0; r < cm.h; r++) {
      var f = cm.rowFirst[r];
      if (f < 0) continue;
      var l = cm.rowLast[r], rowBase = (oy + r) * sw, mBase = r * mw;
      for (var j = f; j <= l; j++) {
        var v = cm.bits[mBase + j];
        if (!v) continue;
        var idx = rowBase + off + j;
        n += popcount(sheet.bits[idx] & (v << s));
        if (s) n += popcount(sheet.bits[idx + 1] & (v >>> (32 - s)));
      }
    }
    return n;
  }

  function placeOne(sheet, part, angles, opt, res, gapPx) {
    var best = null, bestMask = null, seen = {};
    angles = shortlistAngles(part, angles, opt.angleTries || 6);
    for (var a = 0; a < angles.length; a++) {
      var m = maskFor(part, angles[a], res, gapPx);
      if (!m || m.w > sheet.w) { m = null; continue; }
      var key = m.w + 'x' + m.h;
      if (seen[key] === undefined) seen[key] = 0;
      var rough = [], maxX = sheet.w - m.w, step = opt.xStep, x0;
      for (x0 = 0; x0 <= maxX; x0 += step) rough.push({ s: sheet.restY(m, x0) + m.h, x: x0 });
      if (maxX % step !== 0) rough.push({ s: sheet.restY(m, maxX) + m.h, x: maxX });
      rough.sort(function (A, B) { return A.s - B.s || A.x - B.x; });
      var k = Math.min(rough.length, opt.candidates);
      var cm = null;
      for (var i = 0; i < k; i++) {
        if (best && rough[i].s > best.score + (opt.contactSlack || 0)) break;
        var pos = slide(sheet, m, rough[i].x);
        if (!pos) continue;
        var score = pos.y + m.h;
        var ct = 0;
        if (opt.contact) {
          if (!cm) cm = dilateBits(m, 1);
          ct = contactAt(sheet, cm, pos.x, pos.y);
        }
        var better;
        if (!best) better = true;
        else if (opt.contact) {
          var slack = opt.contactSlack || 0;
          if (score < best.score - slack) better = true;
          else if (score > best.score + slack) better = false;
          else better = (ct > best.contact) || (ct === best.contact && score < best.score);
        } else {
          better = score < best.score || (score === best.score && pos.x < best.x);
        }
        if (better) {
          best = { x: pos.x, y: pos.y, score: score, contact: ct, angle: angles[a] };
          bestMask = m;
        }
      }

      // remplissage des trous : une petite pièce cherche aussi une place DANS la matière déjà posée
      /* Une petite pièce ne doit pas se contenter du front de matière : elle
         balaie TOUT ce qui est déjà posé, creux entre grandes pièces compris. */
      if (opt.fillHoles && sheet.used > m.h && m.w * m.h < (opt.smallPx || 120000)) {
        var div = opt.scanFine || 6;
        var sy = Math.max(2, Math.round(m.h / div)), sx = Math.max(2, Math.round(m.w / div));
        for (var yy = 0; yy + m.h < sheet.used; yy += sy) {
          if (best && yy + m.h >= best.score) break;
          for (var xx = 0; xx <= maxX; xx += sx) {
            if (sheet.hit(m, xx, yy)) continue;
            var p2 = slide(sheet, m, xx);        // on laisse glisser depuis ce point libre
            var sc2 = p2 ? p2.y + m.h : 1e9;
            var cand = { x: xx, y: yy, score: yy + m.h, angle: angles[a] };
            if (p2 && sc2 < cand.score) cand = { x: p2.x, y: p2.y, score: sc2, angle: angles[a] };
            if (!best || cand.score < best.score) { best = cand; bestMask = m; }
          }
        }
      }
      if (bestMask !== m) m = null;   // libère les masques inutiles
    }
    if (!best) return null;
    best.mask = bestMask;
    return best;
  }

  function maskFor(part, angle, res, gapPx) {
    var rad = angle * Math.PI / 180, rings = [];
    for (var k = 0; k < part.rings.length; k++) rings.push(rotatePoly(part.rings[k], rad));
    var bb = bboxOf(rings);
    var wpx = (bb[2] - bb[0]) * res, hpx = (bb[3] - bb[1]) * res;
    /* Garde-fou mémoire : une empreinte démesurée est refusée pour CET angle.
       Surtout ne pas la redimensionner à une autre finesse : son quadrillage ne
       correspondrait plus à celui de la feuille, les positions seraient fausses
       et les pièces se chevaucheraient. Essayé, mesuré, jeté — huit contacts.
       Refuser l'angle est sans danger : les autres restent disponibles, et si
       aucun ne passe la pièce est signalée non placée, pas perdue en silence. */
    if (wpx * hpx > 4000000) return null;
    var m = makeMask(rings, res, gapPx, part.union);
    m.angle = angle;
    return m;
  }

  function anglesFor(opt) {
    if (opt.angleStep <= 0) return [0, 180];
    var a = [];
    for (var v = 0; v < 360; v += opt.angleStep) a.push(v);
    return a;
  }

  function safeResolution(parts, opt) {
    var maxDim = 0, i;
    for (i = 0; i < parts.length; i++) {
      var b = bboxOf(parts[i].rings);
      var d = Math.max(b[2] - b[0], b[3] - b[1]);
      if (d > maxDim) maxDim = d;
    }
    var res = opt.resolution;
    if (maxDim * res > 1400) res = 1400 / maxDim;      // pièce géante : on dégrossit
    if (opt.sheetWidth * res > 2200) res = 2200 / opt.sheetWidth;
    if (res < 0.08) res = 0.08;
    return res;
  }

  function nestOnce(parts, order, opt, progress) {
    var res = safeResolution(parts, opt);
    // écart jamais raboté : le tramage arrondit toujours vers le haut, la lame est protégée
    var gapPx = Math.round(opt.gap * res); if (gapPx < 0) gapPx = 0;
    var edgePx = Math.round(opt.edgeMargin * res); if (edgePx < 0) edgePx = 0;
    var usable = Math.floor(opt.sheetWidth * res) - 2 * edgePx;
    if (usable < 4) return null;
    var pad = gapPx + 2;
    var sheet = new Sheet(usable + 2 * pad, 400 + 2 * pad);
    sheet.setBorders(pad, usable);
    guardTopCorners(sheet, pad, usable, opt, res);
    if (opt.maxLength && opt.maxLength < 50000) sheet.cap = Math.round(opt.maxLength * res) + 2 * pad;

    var angles = anglesFor(opt), placements = [], failed = [];
    for (var n = 0; n < order.length; n++) {
      var part = order[n];
      var spot = placeOne(sheet, part, angles, opt, res, gapPx);
      if (!spot) {
        if (part.members) {                       // couple trop encombrant : on repasse aux pièces seules
          for (var mm = 0; mm < part.members.length; mm++) order.push(part.members[mm].part);
        } else failed.push(part);
        if (progress) progress(n + 1, order.length);
        continue;
      }
      var m = spot.mask;
      sheet.stamp(dilatedOf(m), spot.x, spot.y);
      sheet.updateFront(m, spot.x, spot.y);
      if (part.rings.length > 1) sheet.hasHoles = true;
      if (part.members) {
        var pr = m.angle * Math.PI / 180;
        var pairRings = [];
        for (var mi = 0; mi < part.rings.length; mi++) pairRings.push(rotatePoly(part.rings[mi], pr));
        var pb = bboxOf(pairRings);
        var X0 = ((spot.x - pad) / res) + (m.bbox[0] - m.offX) + opt.edgeMargin;
        var Y0 = ((spot.y - pad) / res) + (m.bbox[1] - m.offY) + opt.edgeMargin;
        var ddx = X0 - pb[0], ddy = Y0 - pb[1];
        for (var k2 = 0; k2 < part.members.length; k2++) {
          var mem = part.members[k2];
          var mr = ringsRT(mem.part.rings, mem.angle, mem.dx, mem.dy);
          var mrr = [];
          for (var z2 = 0; z2 < mr.length; z2++) mrr.push(rotatePoly(mr[z2], pr));
          var mb2 = bboxOf(mrr);
          placements.push({
            part: mem.part, angle: (m.angle + mem.angle) % 360,
            x: mb2[0] + ddx, y: mb2[1] + ddy,
            w: mb2[2] - mb2[0], h: mb2[3] - mb2[1]
          });
        }
        if (progress) progress(n + 1, order.length);
        continue;
      }
      placements.push({
        part: part, angle: m.angle,
        x: ((spot.x - pad) / res) + (m.bbox[0] - m.offX) + opt.edgeMargin,
        y: ((spot.y - pad) / res) + (m.bbox[1] - m.offY) + opt.edgeMargin,
        w: m.bbox[2] - m.bbox[0], h: m.bbox[3] - m.bbox[1]
      });
      if (progress) progress(n + 1, order.length);
    }

    var len = 0, area = 0, z;
    for (z = 0; z < placements.length; z++) {
      var b = placements[z].y + placements[z].h;
      if (b > len) len = b;
    }
    if (placements.length) len += opt.edgeMargin;
    for (z = 0; z < parts.length; z++) area += netArea(parts[z]);
    return {
      placements: placements, failed: failed, length: len, partArea: area,
      fill: len > 0 ? area / (len * opt.sheetWidth) : 0
    };
  }

  /* ---------- imbrication par paires ----------
     On tente d'emboîter deux pièces (l'une tournée de 180°, tête-bêche) avant de poser.
     Si le couple tient dans nettement moins de place que les deux séparées, on le garde. */
  function ringsRT(rings, angle, dx, dy) {
    var rad = angle * Math.PI / 180, out = [];
    for (var i = 0; i < rings.length; i++) {
      var r = rotatePoly(rings[i], rad), o = [];
      for (var j = 0; j < r.length; j++) o.push([r[j][0] + dx, r[j][1] + dy]);
      out.push(o);
    }
    return out;
  }

  function tryPair(A, B, res, gapPx, angB) {
    var ma = makeMask(A.rings, res, gapPx, A.union);
    var rb = ringsRT(B.rings, angB, 0, 0);
    var mb = makeMask(rb, res, gapPx, B.union);
    if (ma.w + mb.w > 4000 || ma.h + mb.h > 4000) return null;

    var W = ma.w + 2 * mb.w + 8, H = ma.h + 2 * mb.h + 8;
    var sheet = new Sheet(W, H);
    var ax = mb.w + 4, ay = mb.h + 4;
    sheet.stamp(ma, ax, ay);
    sheet.updateFront(ma, ax, ay);

    var best = null, step = Math.max(2, Math.round(mb.w / 8));
    for (var x = 0; x + mb.w < W; x += step) {
      var pos = slide(sheet, mb, x);
      if (!pos) continue;
      var x0 = Math.min(ax, pos.x), y0 = Math.min(ay, pos.y);
      var x1 = Math.max(ax + ma.w, pos.x + mb.w), y1 = Math.max(ay + ma.h, pos.y + mb.h);
      var area = (x1 - x0) * (y1 - y0);
      if (!best || area < best.area) best = { area: area, x: pos.x, y: pos.y };
    }
    if (!best) return null;

    var solo = ma.w * ma.h + mb.w * mb.h;
    if (best.area > solo * 0.93) return null;            // pas assez de gain : on laisse séparé

    // coordonnées mm du couple, A à l'origine
    var dx = (best.x - ax) / res + (ma.bbox[0] - ma.offX) - (mb.bbox[0] - mb.offX);
    var dy = (best.y - ay) / res + (ma.bbox[1] - ma.offY) - (mb.bbox[1] - mb.offY);
    var rings = A.rings.concat(ringsRT(B.rings, angB, dx, dy));
    return {
      rings: rings, union: true, name: A.name + ' + ' + B.name,
      members: [{ part: A, angle: 0, dx: 0, dy: 0 },
                { part: B, angle: angB, dx: dx, dy: dy }],
      gain: 1 - best.area / solo
    };
  }

  var REL_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

  function buildPairs(parts, opt, res, gapPx, limit) {
    var order = [], i;
    for (i = 0; i < parts.length; i++) order.push(parts[i]);
    order.sort(function (a, b) { return netArea(b) - netArea(a); });
    var used = {}, out = [], made = 0;
    for (i = 0; i < order.length && i < limit; i++) {
      if (used[i]) continue;
      var bestPair = null, bestJ = -1;
      for (var j = i + 1; j < order.length && j < limit; j++) {
        if (used[j]) continue;
        /* toutes les orientations relatives, pas seulement le tête-bêche :
           sur un kit gauche/droite, l'angle qui emboîte n'est presque jamais 180°. */
        for (var ai = 0; ai < REL_ANGLES.length; ai++) {
          var pr = tryPair(order[i], order[j], res, gapPx, REL_ANGLES[ai]);
          if (pr && (!bestPair || pr.gain > bestPair.gain)) { bestPair = pr; bestJ = j; }
        }
      }
      if (bestPair) { used[i] = 1; used[bestJ] = 1; out.push(bestPair); made++; }
    }
    for (i = 0; i < order.length; i++) if (!used[i]) out.push(order[i]);
    return { parts: out, made: made };
  }

  /* contrôle final : on repose toutes les pièces sur une feuille vierge
     et on compte les collisions réelles. Zéro = imbrication saine. */
  function verify(res, opt) {
    var r = opt.resolution, off = 32;                       // marge franche pour ne rien tronquer
    var w = Math.ceil((opt.sheetWidth + 4 * opt.edgeMargin) * r) + 2 * off;
    var sheet = new Sheet(w, Math.ceil(res.length * r) + 2 * off + 64);
    var bad = 0;
    for (var i = 0; i < res.placements.length; i++) {
      var P = res.placements[i];
      var rad = P.angle * Math.PI / 180, rings = [];
      for (var k = 0; k < P.part.rings.length; k++) rings.push(rotatePoly(P.part.rings[k], rad));
      var m = makeMask(rings, r, 0, P.part.union);
      var ox = Math.round((P.x - (m.bbox[0] - m.offX)) * r) + off;
      var oy = Math.round((P.y - (m.bbox[1] - m.offY)) * r) + off;
      if (ox < 0 || oy < 0 || ox + m.w > sheet.w || oy + m.h > sheet.h) continue;   // hors cadre : non concluant
      if (sheet.hit(m, ox, oy)) bad++;
      sheet.stamp(m, ox, oy);
    }
    return bad;
  }

  function orderings(parts, count) {
    var i, idx = [];
    for (i = 0; i < parts.length; i++) idx.push(i);
    var dim = [];
    for (i = 0; i < parts.length; i++) {
      var b = bboxOf(parts[i].rings);
      dim.push([b[2] - b[0], b[3] - b[1]]);
    }
    function cp(a) { return a.slice(0); }
    var byArea = cp(idx).sort(function (a, b) { return netArea(parts[b]) - netArea(parts[a]); });
    var byLong = cp(idx).sort(function (a, b) {
      return Math.max(dim[b][0], dim[b][1]) - Math.max(dim[a][0], dim[a][1]);
    });
    var byH = cp(idx).sort(function (a, b) { return dim[b][1] - dim[a][1]; });
    var byW = cp(idx).sort(function (a, b) { return dim[b][0] - dim[a][0]; });
    var list = [byArea, byLong, byH, byW], seed = 12345;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    /* Deux familles de variantes, en alternance : un mélange LOCAL (on décale
       une pièce de quelques rangs) et un tri sur la surface BRUITÉE, du
       presque-trié au franchement mélangé. Une seule des deux ne suffisait pas :
       la locale trouve les bons plans proches du tri par surface, l'autre va
       chercher ailleurs. */
    var areas = [];
    for (i = 0; i < parts.length; i++) areas.push(netArea(parts[i]));
    var v = 0;
    while (list.length < count) {
      if (v % 2 === 0) {
        var jit = cp(byArea);
        for (var q = jit.length - 1; q > 0; q--) {
          var j2 = Math.max(0, q - 1 - Math.floor(rnd() * 4));
          var t2 = jit[q]; jit[q] = jit[j2]; jit[j2] = t2;
        }
        list.push(jit);
      } else {
        var amp = 0.08 + ((v >> 1) % 12) * 0.09;
        var keys = [];
        for (i = 0; i < parts.length; i++) keys.push([i, areas[i] * (1 + amp * (rnd() * 2 - 1))]);
        keys.sort(function (A, B) { return B[1] - A[1]; });
        var perm = [];
        for (i = 0; i < keys.length; i++) perm.push(keys[i][0]);
        list.push(perm);
      }
      v++;
    }
    var out = [];
    for (i = 0; i < count && i < list.length; i++) {
      var o = [];
      for (var k = 0; k < list[i].length; k++) o.push(parts[list[i][k]]);
      out.push(o);
    }
    return out;
  }


  /* ---------- compactage : on ressort chaque pièce et on la repose au mieux ----------
     Le premier passage pose les pièces dans un ordre figé ; une pièce posée tôt
     bloque parfois une place qui se libère ensuite. On rejoue donc chaque pièce,
     de la plus basse à la plus haute, sur une feuille reconstruite sans elle. */
  function rebuildSheet(list, skip, opt, res, gapPx) {
    var pad = gapPx + 2;
    var usable = Math.floor(opt.sheetWidth * res) - 2 * Math.round(opt.edgeMargin * res);
    var sheet = new Sheet(usable + 2 * pad, 400 + 2 * pad);
    sheet.setBorders(pad, usable);
    guardTopCorners(sheet, pad, usable, opt, res);
    for (var i = 0; i < list.length; i++) {
      if (i === skip) continue;
      var P = list[i];
      var m = maskFor(P.part, P.angle, res, gapPx);
      /* Une pièce qu'on ne sait pas marquer laisserait sa place libre : le
         compactage poserait une voisine par-dessus. On renonce plutôt. */
      if (!m) return null;
      var ox = Math.round((P.x - opt.edgeMargin - (m.bbox[0] - m.offX)) * res) + pad;
      var oy = Math.round((P.y - opt.edgeMargin - (m.bbox[1] - m.offY)) * res) + pad;
      if (oy + m.h > sheet.h) sheet.grow(oy + m.h + 128);
      if (ox < 0 || oy < 0 || ox + m.w > sheet.w || oy + m.h > sheet.h) return null;
      sheet.stamp(dilatedOf(m), ox, oy);
      sheet.updateFront(m, ox, oy);
      if (P.part.rings.length > 1) sheet.hasHoles = true;
    }
    sheet.deepScan = true;        // au compactage, on fouille toute la matière déjà posée
    return sheet;
  }

  function compact(result, opt, rounds) {
    if (!result || result.placements.length < 2) return result;
    var res = safeResolution([], opt) || opt.resolution;
    res = opt.resolution;
    var gapPx = Math.round(opt.gap * res); if (gapPx < 0) gapPx = 0;
    var pad = gapPx + 2;
    var list = result.placements;

    for (var round = 0; round < (rounds || 2); round++) {
      var moved = 0;
      var order = [];
      for (var i = 0; i < list.length; i++) order.push(i);
      order.sort(function (a, b) { return (list[b].y + list[b].h) - (list[a].y + list[a].h); });

      for (var k = 0; k < order.length; k++) {
        var idx = order[k], P = list[idx];
        var sheet = rebuildSheet(list, idx, opt, res, gapPx);
        if (!sheet) continue;                     /* feuille incomplète : on ne touche à rien */
        var spot = placeOne(sheet, P.part, anglesFor(opt), opt, res, gapPx);
        if (!spot) continue;
        var m = spot.mask;
        var nx = ((spot.x - pad) / res) + (m.bbox[0] - m.offX) + opt.edgeMargin;
        var ny = ((spot.y - pad) / res) + (m.bbox[1] - m.offY) + opt.edgeMargin;
        var nh = m.bbox[3] - m.bbox[1];
        if (ny + nh < P.y + P.h - 0.01) {           // la pièce remonte : on garde
          list[idx] = { part: P.part, angle: m.angle, x: nx, y: ny,
                        w: m.bbox[2] - m.bbox[0], h: nh };
          moved++;
        }
      }
      if (!moved) break;
    }

    var len = 0;
    for (var z = 0; z < list.length; z++) {
      var b = list[z].y + list[z].h;
      if (b > len) len = b;
    }
    result.length = len + opt.edgeMargin;
    result.fill = result.length > 0 ? result.partArea / (result.length * opt.sheetWidth) : 0;
    return result;
  }


  /* ---------- démolition-reconstruction ----------
     Au lieu de repartir de zéro à chaque essai, on garde le meilleur plan, on en
     arrache quelques pièces au hasard et on les repose. Le plan n'est conservé
     que s'il raccourcit. C'est ce qui fait progresser un nesteur une fois que
     les redémarrages ne donnent plus rien : on cherche AUTOUR d'une bonne
     solution au lieu de retomber dans les mêmes plans. */
  function ruinRecreate(result, parts, opt, rounds, seed) {
    if (!result || result.placements.length < 3) return result;
    var res = opt.resolution;
    var gapPx = Math.round(opt.gap * res); if (gapPx < 0) gapPx = 0;
    var pad = gapPx + 2;
    var angles = anglesFor(opt);
    var rnd = (function (x) {
      return function () { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
    })(seed || 987654321);

    var bestList = result.placements.slice(0), bestLen = result.length, bestMass = 0;
    for (var bm = 0; bm < bestList.length; bm++) bestMass += bestList[bm].y + bestList[bm].h;

    for (var round = 0; round < (rounds || 40); round++) {
      var n = bestList.length;
      var k = 2 + Math.floor(rnd() * Math.min(6, n - 1));      // 2 à 7 pièces arrachées
      var pulled = {}, order = [];
      while (order.length < k) {
        var idx = Math.floor(rnd() * n);
        if (pulled[idx]) continue;
        pulled[idx] = 1;
        order.push(idx);
      }

      /* feuille reconstruite sans les pièces arrachées */
      var usable = Math.floor(opt.sheetWidth * res) - 2 * Math.round(opt.edgeMargin * res);
      var sheet = new Sheet(usable + 2 * pad, 400 + 2 * pad);
      sheet.setBorders(pad, usable);
      guardTopCorners(sheet, pad, usable, opt, res);
      /* TOUTE pièce conservée doit être reconstruite ET marquée sur la feuille.
       *
       * Avant, une pièce dont l'empreinte ne pouvait pas être construite — une
       * grande pièce à précision fine dépasse le garde-fou mémoire — était
       * sautée : elle disparaissait du plan, et sa place restait libre, donc
       * une autre pièce venait s'y poser. D'où les deux symptômes vus ensemble,
       * des pièces manquantes et des contacts.
       *
       * Un tour d'affinage qui ne peut pas tout reposer est maintenant
       * abandonné en bloc : le plan reste celui d'avant, intact. */
      var kept = [], i, aborted = false;
      for (i = 0; i < n; i++) {
        if (pulled[i]) continue;
        var P = bestList[i];
        var m = maskFor(P.part, P.angle, res, gapPx);
        if (!m) { aborted = true; break; }
        var ox = Math.round((P.x - opt.edgeMargin - (m.bbox[0] - m.offX)) * res) + pad;
        var oy = Math.round((P.y - opt.edgeMargin - (m.bbox[1] - m.offY)) * res) + pad;
        if (ox < 0 || oy < 0) { aborted = true; break; }
        if (oy + m.h > sheet.h) sheet.grow(oy + m.h + 128);
        if (ox + m.w > sheet.w || oy + m.h > sheet.h) { aborted = true; break; }
        sheet.stamp(dilatedOf(m), ox, oy);
        sheet.updateFront(m, ox, oy);
        if (P.part.rings.length > 1) sheet.hasHoles = true;
        kept.push(P);
      }
      if (aborted) continue;

      /* on repose les arrachées, les plus grosses d'abord */
      order.sort(function (a, b) { return netArea(bestList[b].part) - netArea(bestList[a].part); });
      var ok = true;
      for (i = 0; i < order.length; i++) {
        var part = bestList[order[i]].part;
        var spot = placeOne(sheet, part, angles, opt, res, gapPx);
        if (!spot) { ok = false; break; }
        var mm = spot.mask;
        sheet.stamp(dilatedOf(mm), spot.x, spot.y);
        sheet.updateFront(mm, spot.x, spot.y);
        if (part.rings.length > 1) sheet.hasHoles = true;
        kept.push({
          part: part, angle: mm.angle,
          x: ((spot.x - pad) / res) + (mm.bbox[0] - mm.offX) + opt.edgeMargin,
          y: ((spot.y - pad) / res) + (mm.bbox[1] - mm.offY) + opt.edgeMargin,
          w: mm.bbox[2] - mm.bbox[0], h: mm.bbox[3] - mm.bbox[1]
        });
      }
      if (!ok) continue;

      var len = 0, mass = 0;
      for (i = 0; i < kept.length; i++) {
        var b = kept[i].y + kept[i].h;
        if (b > len) len = b;
        mass += b;                       // somme des bords bas : mesure fine du tassement
      }
      len += opt.edgeMargin;
      /* On accepte aussi un plan de même longueur mais mieux tassé : c'est lui
         qui, deux ou trois démolitions plus loin, libère la dernière rangée. */
      if (len < bestLen - 0.01 || (len < bestLen + 0.01 && mass < bestMass - 0.01)) {
        bestLen = len; bestList = kept; bestMass = mass;
      }
    }

    result.placements = bestList;
    result.length = bestLen;
    result.fill = bestLen > 0 ? result.partArea / (bestLen * opt.sheetWidth) : 0;
    return result;
  }


  /* ---------- remplissage des vides ----------
     Une fois la planche calculée, il reste de la chute entre les pièces. On y
     pose autant de copies d'un même petit motif — un logo, une pastille — que
     la place le permet, sans jamais toucher aux pièces déjà posées ni allonger
     la planche.

     On reconstruit la feuille à partir du plan existant, puis on appelle le
     même placeur que pour les pièces, avec le balayage complet activé : le
     motif va donc se loger dans les creux fermés, pas seulement sur le front. */
  function fillFree(result, logo, opt, maxCount) {
    if (!result || !result.placements.length) return [];
    var res = opt.resolution;
    var gapPx = Math.round(opt.gap * res); if (gapPx < 0) gapPx = 0;
    var pad = gapPx + 2;
    var usable = Math.floor(opt.sheetWidth * res) - 2 * Math.round(opt.edgeMargin * res);
    var maxLen = Math.ceil((result.length - opt.edgeMargin) * res) + 2 * pad;

    var sheet = new Sheet(usable + 2 * pad, Math.max(400 + 2 * pad, maxLen));
    sheet.setBorders(pad, usable);
    sheet.cap = maxLen;                     /* interdit d'allonger la planche */

    var i, P, m;
    for (i = 0; i < result.placements.length; i++) {
      P = result.placements[i];
      m = maskFor(P.part, P.angle, res, gapPx);
      if (!m) continue;
      var ox = Math.round((P.x - opt.edgeMargin - (m.bbox[0] - m.offX)) * res) + pad;
      var oy = Math.round((P.y - opt.edgeMargin - (m.bbox[1] - m.offY)) * res) + pad;
      if (ox < 0 || oy < 0) continue;
      if (oy + m.h > sheet.h) continue;
      sheet.stamp(dilatedOf(m), ox, oy);
      sheet.updateFront(m, ox, oy);
    }
    sheet.deepScan = true;                  /* on fouille toute la matière posée */

    var angles = anglesFor(opt), out = [], guard = 0;
    var cap = maxCount || 200;
    while (out.length < cap && guard++ < cap + 20) {
      var spot = placeOne(sheet, logo, angles, opt, res, gapPx);
      if (!spot) break;
      m = spot.mask;
      sheet.stamp(dilatedOf(m), spot.x, spot.y);
      sheet.updateFront(m, spot.x, spot.y);
      out.push({
        angle: m.angle,
        x: ((spot.x - pad) / res) + (m.bbox[0] - m.offX) + opt.edgeMargin,
        y: ((spot.y - pad) / res) + (m.bbox[1] - m.offY) + opt.edgeMargin,
        w: m.bbox[2] - m.bbox[0], h: m.bbox[3] - m.bbox[1]
      });
    }
    return out;
  }

  /* ---------- libérer les coins d'un plan déjà calculé ----------
     Sert à TOUT plan : celui de V10 (dont seuls les coins bas restent à
     vérifier, les hauts étant bloqués dès le départ) et surtout celui de
     Sparrow, qui ne sait rien des coins. On teste la forme réelle de chaque
     pièce — pas sa boîte — contre les quatre carrés : une pièce dont seule la
     boîte effleure un coin n'est pas déplacée pour rien.

     Les pièces fautives sont arrachées et reposées par le placeur de V10 sur
     une feuille où les coins sont des murs. D'abord sans allonger la planche ;
     si une pièce ne trouve pas de place, la planche grandit d'un carré et on
     recommence. Le reste du plan n'est jamais touché. */
  /* which : 'top' = seulement les deux coins hauts, 'all' = les quatre. */
  function cornerOffendersRaster(list, opt, res, gapPx, lengthMm, which) {
    var pad = gapPx + 2;
    var usable = Math.floor(opt.sheetWidth * res) - 2 * Math.round(opt.edgeMargin * res);
    var bot = Math.round((lengthMm - 2 * (opt.edgeMargin || 0)) * res) + pad;
    var probe = new Sheet(usable + 2 * pad, bot + 4);
    if (which === 'top') guardTopCorners(probe, pad, usable, opt, res);
    else blockAllCorners(probe, pad, usable, opt, res, lengthMm);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var P = list[i];
      var m = maskFor(P.part, P.angle, res, gapPx);
      if (!m) continue;
      var ox = Math.round((P.x - opt.edgeMargin - (m.bbox[0] - m.offX)) * res) + pad;
      var oy = Math.round((P.y - opt.edgeMargin - (m.bbox[1] - m.offY)) * res) + pad;
      if (ox < 0 || oy < 0 || ox + m.w > probe.w) continue;
      if (oy + m.h > probe.h) probe.grow(oy + m.h + 4);
      var hitCorner = false;
      try { hitCorner = probe.hit(m, ox, oy); } catch (eH) { hitCorner = false; }
      if (hitCorner) out.push(i);
    }
    return out;
  }

  function planLength(list, opt) {
    var len = 0;
    for (var i = 0; i < list.length; i++) { var b = list[i].y + list[i].h; if (b > len) len = b; }
    return len + opt.edgeMargin;
  }

  /* Arrache les pièces fautives et les repose ailleurs, coins bloqués. */
  function relocateOffenders(list, length, parts, opt, which) {
    var res = safeResolution(parts, opt);
    var gapPx = Math.round(opt.gap * res); if (gapPx < 0) gapPx = 0;
    var pad = gapPx + 2;
    var usable = Math.floor(opt.sheetWidth * res) - 2 * Math.round(opt.edgeMargin * res);
    var g = opt.cornerGuardSize > 0 ? opt.cornerGuardSize : 25;
    var angles = anglesFor(opt), moved = 0;
    var pending = cornerOffendersRaster(list, opt, res, gapPx, length, which);

    for (var round = 0; round < 6 && pending.length; round++) {
      var bot = Math.round((length - 2 * opt.edgeMargin) * res) + pad;
      var sheet = new Sheet(usable + 2 * pad, bot + 128);
      sheet.setBorders(pad, usable);
      if (which === 'top') guardTopCorners(sheet, pad, usable, opt, res);
      else blockAllCorners(sheet, pad, usable, opt, res, length);

      var pulled = {}, i;
      for (i = 0; i < pending.length; i++) pulled[pending[i]] = 1;
      for (i = 0; i < list.length; i++) {
        if (pulled[i]) continue;
        var P = list[i], m = maskFor(P.part, P.angle, res, gapPx);
        if (!m) return null;                      /* plan illisible : on n'y touche pas */
        var ox = Math.round((P.x - opt.edgeMargin - (m.bbox[0] - m.offX)) * res) + pad;
        var oy = Math.round((P.y - opt.edgeMargin - (m.bbox[1] - m.offY)) * res) + pad;
        if (ox < 0 || oy < 0) return null;
        if (oy + m.h > sheet.h) sheet.grow(oy + m.h + 128);
        sheet.stamp(dilatedOf(m), ox, oy);
        sheet.updateFront(m, ox, oy);
        if (P.part.rings.length > 1) sheet.hasHoles = true;
      }
      sheet.deepScan = true;
      sheet.cap = round === 0 ? bot : 0;          /* d'abord sans allonger */

      var order = pending.slice(0), failed = 0;
      order.sort(function (a, b) { return netArea(list[b].part) - netArea(list[a].part); });
      for (i = 0; i < order.length; i++) {
        var part = list[order[i]].part, spot = null;
        try { spot = placeOne(sheet, part, angles, opt, res, gapPx); } catch (eP) { spot = null; }
        if (!spot) { failed++; continue; }
        var mm = spot.mask;
        sheet.stamp(dilatedOf(mm), spot.x, spot.y);
        sheet.updateFront(mm, spot.x, spot.y);
        list[order[i]] = {
          part: part, angle: mm.angle,
          x: ((spot.x - pad) / res) + (mm.bbox[0] - mm.offX) + opt.edgeMargin,
          y: ((spot.y - pad) / res) + (mm.bbox[1] - mm.offY) + opt.edgeMargin,
          w: mm.bbox[2] - mm.bbox[0], h: mm.bbox[3] - mm.bbox[1]
        };
        moved++;
      }
      var newLen = planLength(list, opt);
      length = failed ? Math.max(newLen, length + g) : (which === 'top' ? Math.max(newLen, length) : newLen);
      pending = cornerOffendersRaster(list, opt, res, gapPx, length, which);
    }
    return { list: list, length: length, moved: moved, stuck: pending.length };
  }

  /* Coins bas : plutôt que déplacer une grosse pièce, il suffit souvent
     d'allonger la planche de moins d'un carré pour que les coins passent
     sous les pièces des bords. */
  function extendForBottom(list, length, opt) {
    var g = opt.cornerGuardSize > 0 ? opt.cornerGuardSize : 25, W = opt.sheetWidth, need = length;
    for (var i = 0; i < list.length; i++) {
      var P = list[i];
      if (P.x < g || P.x + P.w > W - g) need = Math.max(need, P.y + P.h + g + 1);
    }
    return need;
  }

  /* Pousser : une pièce qui mord dans un coin de quelques millimètres peut
     souvent glisser juste assez pour en sortir, sans rien déplacer d'autre.
     On essaie des glissements croissants, en s'éloignant du coin (le long du
     bord, perpendiculairement, puis en diagonale), sur une feuille où tout le
     reste du plan et les quatre coins sont des murs. La longueur ne change
     pas. Si une seule pièce ne peut pas sortir, ce candidat est abandonné. */
  function nudgeOffenders(list, length, parts, opt) {
    var res = safeResolution(parts, opt);
    var gapPx = Math.round(opt.gap * res); if (gapPx < 0) gapPx = 0;
    var pad = gapPx + 2;
    var usable = Math.floor(opt.sheetWidth * res) - 2 * Math.round(opt.edgeMargin * res);
    var maxD = cornerPx(opt, res) + gapPx + 3;
    list = list.slice(0);
    var pending = cornerOffendersRaster(list, opt, res, gapPx, length, 'all'), moved = 0;
    for (var n = 0; n < pending.length; n++) {
      var idx = pending[n], i;
      var bot = Math.round((length - 2 * opt.edgeMargin) * res) + pad;
      var sheet = new Sheet(usable + 2 * pad, bot + 4);
      sheet.setBorders(pad, usable);
      blockAllCorners(sheet, pad, usable, opt, res, length);
      for (i = 0; i < list.length; i++) {
        if (i === idx) continue;
        var Q = list[i], mq = maskFor(Q.part, Q.angle, res, gapPx);
        if (!mq) return null;
        var qx = Math.round((Q.x - opt.edgeMargin - (mq.bbox[0] - mq.offX)) * res) + pad;
        var qy = Math.round((Q.y - opt.edgeMargin - (mq.bbox[1] - mq.offY)) * res) + pad;
        if (qx < 0 || qy < 0) return null;
        if (qy + mq.h > sheet.h) sheet.grow(qy + mq.h + 4);
        sheet.stamp(dilatedOf(mq), qx, qy);
      }
      var P = list[idx], m = maskFor(P.part, P.angle, res, gapPx);
      if (!m) return null;
      var ox = Math.round((P.x - opt.edgeMargin - (m.bbox[0] - m.offX)) * res) + pad;
      var oy = Math.round((P.y - opt.edgeMargin - (m.bbox[1] - m.offY)) * res) + pad;
      var sx = (P.x + P.w / 2 < opt.sheetWidth / 2) ? 1 : -1;     /* s'éloigner du bord touché */
      var sy = (P.y + P.h / 2 < length / 2) ? 1 : -1;
      var found = null;
      for (var d = 1; d <= maxD && !found; d++) {
        var tries = [[sx * d, 0], [0, sy * d], [sx * d, sy * d]];
        for (var t = 0; t < tries.length; t++) {
          var nx = ox + tries[t][0], ny = oy + tries[t][1];
          if (nx < 0 || ny < 0 || nx + m.w > sheet.w || ny + m.h > bot) continue;
          if (!sheet.hit(m, nx, ny)) { found = tries[t]; break; }
        }
      }
      if (!found) return null;
      list[idx] = { part: P.part, angle: P.angle, x: P.x + found[0] / res, y: P.y + found[1] / res, w: P.w, h: P.h };
      moved++;
    }
    if (cornerOffendersRaster(list, opt, res, gapPx, length, 'all').length) return null;
    return { list: list, length: length, moved: moved, stuck: 0 };
  }

  function guardCorners(result, parts, opt) {
    var report = { moved: 0, stuck: 0, grown: false };
    if (!opt.cornerGuard || !result || !result.placements || !result.placements.length) return report;
    var res = safeResolution(parts, opt);
    var gapPx = Math.round(opt.gap * res); if (gapPx < 0) gapPx = 0;
    var L0 = result.length;
    if (!cornerOffendersRaster(result.placements, opt, res, gapPx, L0, 'all').length) return report;

    /* Deux façons de libérer les coins ; on garde la planche la plus courte.
       A : on déplace tout ce qui touche un coin.
       B : on ne déplace que ce qui touche un coin HAUT, et on allonge juste
           assez pour que les coins bas passent sous les pièces. */
    var cands = [];
    /* N : pousser les pièces fautives de quelques millimètres — longueur inchangée */
    var N = nudgeOffenders(result.placements, L0, parts, opt);
    if (N) cands.push(N);
    var A = relocateOffenders(result.placements.slice(0), L0, parts, opt, 'all');
    if (A && !A.stuck) cands.push(A);
    var B = relocateOffenders(result.placements.slice(0), L0, parts, opt, 'top');
    if (B && !B.stuck) {
      B.length = extendForBottom(B.list, B.length, opt);
      B.stuck = cornerOffendersRaster(B.list, opt, res, gapPx, B.length, 'all').length;
      if (!B.stuck) cands.push(B);
    }
    /* C : on descend le plan entier d'un bloc, juste assez pour que les
           pièces des bords passent sous les coins hauts, puis on allonge pour
           les coins bas. Rien ne bouge l'une par rapport à l'autre : jamais de
           contact, et au pire deux carrés de plus. */
    var g = opt.cornerGuardSize > 0 ? opt.cornerGuardSize : 25, dy = 0, P, k;
    for (k = 0; k < result.placements.length; k++) {
      P = result.placements[k];
      if (P.x < g || P.x + P.w > opt.sheetWidth - g) dy = Math.max(dy, g - P.y + 1);
    }
    var Cl = [];
    for (k = 0; k < result.placements.length; k++) {
      P = result.placements[k];
      Cl.push({ part: P.part, angle: P.angle, x: P.x, y: P.y + dy, w: P.w, h: P.h });
    }
    var C = { list: Cl, length: extendForBottom(Cl, planLength(Cl, opt), opt), moved: 0 };
    C.stuck = cornerOffendersRaster(C.list, opt, res, gapPx, C.length, 'all').length;
    if (!C.stuck) cands.push(C);

    /* R : le plan entier retourné de 180° (chaque pièce tourne d'un demi-tour,
       l'ensemble garde sa forme). Les coins du haut deviennent ceux du bas :
       utile quand un côté du plan est bien plus encombré que l'autre. Seulement
       si la rotation est autorisée et que le demi-tour fait partie des angles. */
    if (!opt._noFlip && opt.angleStep > 0 && (180 % opt.angleStep) === 0) {
      var Rl = [];
      for (k = 0; k < result.placements.length; k++) {
        P = result.placements[k];
        Rl.push({ part: P.part, angle: (P.angle + 180) % 360,
                  x: opt.sheetWidth - P.x - P.w, y: L0 - P.y - P.h, w: P.w, h: P.h });
      }
      var sub = { placements: Rl, length: L0, partArea: result.partArea };
      var o2 = {}; for (var kk in opt) if (opt.hasOwnProperty(kk)) o2[kk] = opt[kk];
      o2._noFlip = true;
      var rr = guardCorners(sub, parts, o2);
      if (!rr.stuck) cands.push({ list: sub.placements, length: sub.length, moved: rr.moved, stuck: 0, flipped: true });
    }

    var pick = null;
    for (var c = 0; c < cands.length; c++) {
      if (!pick || cands[c].length < pick.length - 0.01 ||
          (Math.abs(cands[c].length - pick.length) <= 0.01 && pick.flipped && !cands[c].flipped)) pick = cands[c];
    }
    if (!pick) { pick = A || B; if (!pick) return report; }

    result.placements = pick.list;
    result.length = pick.length;
    if (!result.partArea) { var a = 0; for (var z = 0; z < parts.length; z++) a += netArea(parts[z]); result.partArea = a; }
    result.fill = pick.length > 0 ? result.partArea / (pick.length * opt.sheetWidth) : 0;
    report.moved = pick.moved;
    report.flipped = !!pick.flipped;
    report.stuck = pick.stuck;
    report.grown = pick.length > L0 + 0.01;
    return report;
  }

  /* ---------- remplissage de la chute par des stickers ----------
     Jusqu'à trois modèles, chacun avec sa taille (fixe, ou variable entre un
     mini et un maxi) et son propre plafond de copies. La planche ne s'allonge
     jamais ; l'écart de lame est celui des pièces ; les coins Graphtec restent
     libres. Les modèles sont semés sur UNE feuille partagée, par petits
     paquets et à tour de rôle (voir main.js) : deux modèles de même taille se
     partagent les places au lieu que le premier rafle tout. */
  function scalePart(part, s) {
    if (s === 1) return part;
    var rings = [], i, j;
    for (i = 0; i < part.rings.length; i++) {
      var r = part.rings[i], o = new Array(r.length);
      for (j = 0; j < r.length; j++) o[j] = [r[j][0] * s, r[j][1] * s];
      rings.push(o);
    }
    return { rings: rings, union: part.union, name: part.name, scale: s };
  }

  function settleAt(sheet, m, x, y) {
    var moved = true, loops = 0;
    while (moved && loops++ < 30) {
      moved = false;
      while (y > 0 && !sheet.hit(m, x, y - 1)) { y--; moved = true; }
      while (x > 0 && !sheet.hit(m, x - 1, y)) { x--; moved = true; }
    }
    return { x: x, y: y };
  }

  function buildFillBase(result, parts, opt) {
    if (!result || !result.placements || !result.placements.length) return null;
    var res = safeResolution(parts, opt);
    var gapPx = Math.round(opt.gap * res); if (gapPx < 0) gapPx = 0;
    var pad = gapPx + 2;
    var usable = Math.floor(opt.sheetWidth * res) - 2 * Math.round(opt.edgeMargin * res);
    if (usable < 4) return null;
    var maxY = Math.round((result.length - 2 * opt.edgeMargin) * res) + pad;
    if (maxY <= pad + 4) return null;

    var sheet = new Sheet(usable + 2 * pad, maxY + 2);
    sheet.setBorders(pad, usable);
    for (var i = 0; i < result.placements.length; i++) {
      var P = result.placements[i];
      var pm = maskFor(P.part, P.angle, res, gapPx);
      if (!pm) continue;
      var ox = Math.round((P.x - opt.edgeMargin - (pm.bbox[0] - pm.offX)) * res) + pad;
      var oy = Math.round((P.y - opt.edgeMargin - (pm.bbox[1] - pm.offY)) * res) + pad;
      if (ox < 0 || oy < 0) continue;
      if (oy + pm.h > sheet.h) sheet.grow(oy + pm.h + 8);
      sheet.stamp(dilatedOf(pm), ox, oy);
    }
    if (opt.cornerGuard) blockAllCorners(sheet, pad, usable, opt, res, result.length);
    return { sheet: sheet, res: res, gapPx: gapPx, pad: pad, maxY: maxY, edgeMargin: opt.edgeMargin };
  }

  /* Sème UN modèle sur la base partagée ; ce qui est posé y est marqué, donc
     les appels suivants (autre paquet, autre modèle) ne peuvent pas recouvrir. */
  function scanFiller(base, filler, cfg) {
    var out = [], added = 0;
    if (!base || !filler || !filler.rings || !filler.rings.length) return { placements: out, area: 0, count: 0 };
    var sheet = base.sheet, res = base.res, gapPx = base.gapPx, pad = base.pad, maxY = base.maxY;
    var scales = cfg.scales && cfg.scales.length ? cfg.scales : [1];
    var angles = cfg.angles && cfg.angles.length ? cfg.angles : [0];
    var cap = cfg.maxCount > 0 ? cfg.maxCount : 200;
    for (var s = 0; s < scales.length && out.length < cap; s++) {
      var sp = scalePart(filler, scales[s]);
      for (var a = 0; a < angles.length && out.length < cap; a++) {
        var m = maskFor(sp, angles[a], res, gapPx);
        if (!m || m.w >= sheet.w || m.h > maxY - pad) continue;
        var dil = dilatedOf(m);
        var stepX = Math.max(1, Math.round(m.w / 4)), stepY = Math.max(1, Math.round(m.h / 4));
        for (var y = 0; y + m.h <= maxY && out.length < cap; y += stepY) {
          for (var x = 0; x + m.w <= sheet.w && out.length < cap; x += stepX) {
            if (sheet.hit(m, x, y)) continue;
            var p = settleAt(sheet, m, x, y);
            if (p.y + m.h > maxY || sheet.hit(m, p.x, p.y)) continue;
            sheet.stamp(dil, p.x, p.y);
            out.push({
              part: sp, angle: angles[a], scale: scales[s],
              x: ((p.x - pad) / res) + (m.bbox[0] - m.offX) + base.edgeMargin,
              y: ((p.y - pad) / res) + (m.bbox[1] - m.offY) + base.edgeMargin,
              w: m.bbox[2] - m.bbox[0], h: m.bbox[3] - m.bbox[1]
            });
            added += netArea(sp);
          }
        }
      }
    }
    return { placements: out, area: added, count: out.length };
  }

  return {
    nestOnce: nestOnce, fillFree: fillFree, guardCorners: guardCorners,
    buildFillBase: buildFillBase, scanFiller: scanFiller, scalePart: scalePart, compact: compact, ruinRecreate: ruinRecreate, orderings: orderings, verify: verify, buildPairs: buildPairs,
    safeResolution: safeResolution, netArea: netArea, bboxOf: bboxOf, rotatePoly: rotatePoly
  };
})();
