# pi-tterhaslinedit

> Hashline read/edit tool override for [pi-coding-agent](https://github.com/mariozechner/pi-coding-agent) — with a **7-stage pipeline**, **dual context anchors**, **indentation validation**, and **post-write verification**.

## Pourquoi ce fork ?

`pi-hashline-edit` original (v0.4.1) fonctionne bien pour des edits simples, mais il a des failles silencieuses :

- ❌ Un fichier modifié entre le read et l'edit → **apply silencieux, corruption**
- ❌ Un range trop large → **détruit du contexte sans avertissement**
- ❌ Race condition → **écrase les changements concurrents**
- ❌ No-op → **retourne noopEdits mais n'empêche rien**
- ❌ Pas de vérification après écriture

`pi-tterhaslinedit` corrige tout ça avec un **pipeline 7 stages** fiable.

---

## Pipeline 7 stages

Chaque edit passe par 7 étapes strictes :

```
read → anchor → validate → simulate → revalidate → write → verify
```

| Stage | Ce qu'il fait |
|---|---|
| **read** | Normalise le contenu (LF, BOM strip) |
| **anchor** | Parse tous les anchors (pos, end, anchor1, anchor2) |
| **validate** | Vérifie que chaque hash anchor match le fichier actuel |
| **simulate** | Applique les edits en mémoire, génère un diff |
| **revalidate** | Vérifie que les context anchors existent toujours après simulation |
| **write** | Écriture atomique sur disque |
| **verify** | Re-lit le fichier et compare byte-for-byte avec la simulation |

Si **n'importe quel stage échoue** → l'edit est rejeté avec un message clair. Zéro corruption silencieuse.

---

## Dual Context Anchors (anchor1 + anchor2)

En plus des anchors `pos` et `end`, tu peux fournir **2 anchors de contexte** :

```
anchor1 ──────► pos ──► end ──────► anchor2
(garde-fou)     (edit zone)        (garde-fou)
```

### Comment ça marche

- **`anchor1`** = une ligne AVANT la zone d'edit (typiquement 1-3 lignes au-dessus)
- **`anchor2`** = une ligne APRÈS la zone d'edit (typiquement 1-3 lignes en-dessous)

Le pipeline vérifie :
1. Que anchor1 et anchor2 matchent le fichier actuel (stage **validate**)
2. Qu'ils sont **en dehors** de la zone d'edit
3. Que leur contenu existe **toujours** après simulation (stage **revalidate**)

### Résultat

| Scénario | Ancien (v0.4.1) | pi-tterhaslinedit (v0.5.0) |
|---|---|---|
| Edit normal | ✅ OK | ✅ OK |
| Fichier modifié entre read/edit | ⚠️ Corrompu silencieux | ❌ **Rejeté** (validate) |
| Range trop large | ⚠️ Détruit le contexte | ✅ Contexte préservé |
| No-op (contenu identique) | ⚠️ noopEdits ambigu | ❌ **Échec explicite** (simulate) |
| Anchor dans zone d'edit | ✅ Succès trompeur | ❌ **Rejeté** (validate) |
| Race condition | ⚠️ Écrase les changements | ✅ **Verify byte-for-byte** |
| Simulation sans écriture | ❌ Pas possible | ✅ **simulateOnly=true** |

---

## Indentation validation

Le pipeline détecte automatiquement les incohérences d'indentation :

- **Tabs → Spaces** : warn si tu mets des espaces dans un fichier tab-indented
- **Spaces → Tabs** : warn si tu mets des tabs dans un fichier space-indented
- **Mixed** : warn si tu mélanges tabs et spaces

Tout est en **warnings** (pas de blocage) — tu gardes le contrôle.

---

## Simulation-only mode

Tu peux preview un edit sans écrire sur disque :

```json
{
  "simulateOnly": true
}
```

Ça exécute les 4 premiers stages (read → simulate) et retourne le **diff** sans toucher au fichier. Parfait pour valider avant d'apply.

---

## Installation

```bash
pi install pi-tterhaslinedit
```

Ou manuellement dans ton `.pi/extensions/`.

---

## Comparatif performance

```
Pipeline 7 stages timeline:
  read         ✅  0ms
  anchor       ✅  0.02ms
  validate     ✅  0.06ms
  simulate     ✅  0.2ms
  revalidate   ✅  0.01ms
  write        ✅  1.3ms
  verify       ✅  0.1ms
  ─────────────────────
  Total        ~1.7ms
```

Overhead du pipeline vs l'ancien mode : **~0.5ms**. Négligeable.

---

## Bilan

```
Ancien (v0.4.1)
  Corruptions silencieuses: 4
  Protections:             3

pi-tterhaslinedit (v0.5.0)
  Corruptions silencieuses: 0
  Protections:              7
```

**45 tests • 154 assertions • 0 failures**

---

## Mode strict byte-level (niveau 3)

Le fork supporte maintenant un mode **strict local** pour des edits lossless et vérifiés en bytes.

### Read lossless

```ts
read({ path: "src/file.ts", mode: "lossless" })
```

Retourne pour chaque ligne :
- `LINE#HASH`
- `start` / `end` byte offsets
- `len`
- `eol` (`lf`, `crlf`, `none`)
- `b64` = bytes exacts de la ligne
- `preview` échappé
- hash `sha256` du fichier entier

### Edit strict

```ts
edit({
  path: "src/file.ts",
  strict: true,
  expectedFileHash: "sha256:...",
  edits: [
    {
      op: "replace",
      pos: "12#KJ",
      end: "14#VR",
      lines: ["merged"],
      expectedStartByte: 183,
      expectedEndByte: 244,
      expectedBytesBase64: "...",
      expectedHash: "sha256:..."
    }
  ]
})
```

Le mode strict fait :
1. relecture brute du fichier
2. vérification des anchors
3. vérification exacte de la plage binaire
4. vérification sha256
5. remplacement par byte splice
6. écriture atomique
7. vérification post-write byte-for-byte

Si une seule vérification échoue, l'edit est rejeté.

---

## License

MIT © Wellynounet
