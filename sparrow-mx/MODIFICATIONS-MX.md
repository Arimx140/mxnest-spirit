# Moteur Sparrow modifié pour MXNestSpirit (sparrow-mx)

Ce dossier contient tout ce qu'il faut pour reconstruire le moteur de nesting
livré avec le panneau (`spiritpanel/bin/sparrow.exe` et `spiritpanel/bin/sparrow`) :

- `preparer.sh` télécharge Sparrow au commit indiqué et jagua-rs 0.8.1 (empreinte
  vérifiée), puis applique nos deux correctifs ;
- `sparrow-mx.diff` et `jagua-rs-0.8.1-mx.diff` sont ces correctifs, complets ;
- `Cargo.lock` fige les versions de toutes les dépendances.

GitHub fait tout cela automatiquement (`.github/workflows/sparrow-mx.yml`) à chaque
modification de ce dossier, compile pour Windows et Mac, et dépose les exécutables
dans `spiritpanel/bin/`. Les sources complètes ainsi reconstruites sont jointes à
chaque compilation (artefact « sources-sparrow-mx » dans l'onglet Actions).

## Base

- Sparrow 0.2.0, commit `9ef45676695ef94d045ac8bff0530822127f1437`
  (https://github.com/JeroenGar/sparrow), licence MIT, © 2025 Jeroen Gardeyn, KU Leuven.
- jagua-rs 0.8.1 (https://crates.io/crates/jagua-rs/0.8.1), licence MPL-2.0,
  archive sha256 `9d7caee14697389b200dcae02809a50e301ccc3316dbd7b732e77d50923d46c4`.
  Modifié : conformément à la MPL-2.0, les fichiers modifiés restent sous MPL-2.0 ;
  leur source est le correctif ci-dessous appliqué à cette archive.

## Modifications de Sparrow (`sparrow-mx.diff`)

1. Correctif officiel #161 (`src/eval/collision_loss.rs`) : une évaluation sans
   borne reste sans borne même si la perte accumulée déborde.
2. Repli dans `src/optimizer/worker.rs` : si la recherche ne rend aucune position
   pour une pièce, la pièce garde sa place, un avertissement est journalisé une
   fois, et le calcul continue au lieu de s'arrêter.
   (1 et 2 reprennent les deux corrections du moteur livré avec MXNestSpirit 2.0,
   décrites dans THIRD_PARTY_NOTICES.txt.)
3. `Cargo.toml` : jagua-rs est pris dans le dossier local `jagua-rs/`
   (reconstruit par `preparer.sh`) au lieu de crates.io.

## Modifications de jagua-rs (`jagua-rs-0.8.1-mx.diff`) — coins Graphtec

- `src/probs/spp/io/ext_repr.rs` : champ facultatif `corner_notch` dans le fichier
  d'entrée (côté du carré à laisser vide à chaque coin de la bande). Absent = 0 :
  sans ce champ, le moteur se comporte exactement comme avant.
- `src/probs/spp/io/import.rs` : la valeur est transmise à la bande.
- `src/probs/spp/entities/strip.rs` : la bande devient un rectangle aux quatre
  coins entaillés. Tout ce qui est hors du contour est interdit ; la bande étant
  reconstruite à chaque changement de longueur, les deux coins du fond suivent
  la longueur pendant toute la recherche.
- `src/probs/spp/entities/problem.rs` : quand la bande est resserrée au plus
  court, une pièce située dans la hauteur d'un coin du fond doit s'arrêter une
  entaille avant la fin.

## Vérifié

Sur des kits de test (laize 1330, écart 2 mm, carré 25 mm), à travers la chaîne
complète du panneau : aucune pièce dans les carrés, toutes au moins à l'écart de
lame des coins, aucun contact, aucune pièce hors de la bande ; la réparation du
panneau n'a plus rien à corriger. Sans le champ `corner_notch`, résultat identique
au moteur d'origine.
