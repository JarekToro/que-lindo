//! Order-independent moment grouping: capacitated average-linkage
//! agglomeration on signed pairwise weights (the GAEC recipe from the
//! correlation-clustering literature), finished with a BOEM local-search
//! pass. Every decision is a global argmax over sets with ties broken by
//! the caller's stable ids, so a shuffled import builds the same film.

/// Everything the pairwise weight can draw on for one photo or clip.
#[derive(Debug, Clone, Default)]
pub struct MediaFeatures {
    pub is_image: bool,
    /// Unix seconds when the file says it was shot; None when nothing says.
    pub captured_at: Option<i64>,
    /// L2-normalized scene embedding (CLIP); None without a model.
    pub embedding: Option<Vec<f32>>,
    /// L2-normalized identity embedding per detected face.
    pub faces: Vec<Vec<f32>>,
    /// 6x6 mean-RGB fingerprint (108 bytes, row-major).
    pub signature: Option<Vec<u8>>,
    /// Faces the detector counted; None = detection didn't run, Some(0) is
    /// treated as "no evidence" (wide shots and motion blur hide faces).
    pub face_count: Option<u32>,
}

/// Photos shot within this many seconds are one moment when both are dated.
pub const GROUP_WINDOW: f64 = 90.0;
/// Most photos one collage holds.
pub const GROUP_SIZE: usize = 4;

// Scene term: the calibrated join/reject bands' midpoint becomes zero.
// Calibrated against the app's own int8 CLIP model — quantization shifts
// cosine scores down versus fp32, so the midpoint sits below fp32 tuning.
const SCENE_MID: f32 = 0.67;
const SCENE_HALF: f32 = 0.04;
const W_TONE: f32 = 1.0;
const SIGNATURE_WINDOW: f32 = 36.0;
// Face identity is a bounded bonus: it finds people, not moments (the same
// people attend many events), so it can only tip a pair whose scenes are
// already close — never make a far pair positive on its own.
const FACE_TH: f32 = 0.6;
const FACE_GAIN: f32 = 20.0;
const FACE_CAP: f32 = 1.2;

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

fn best_face_match(a: &[Vec<f32>], b: &[Vec<f32>]) -> f32 {
    let mut best = 0.0f32;
    for x in a {
        for y in b {
            best = best.max(dot(x, y));
        }
    }
    best
}

fn signature_distance(a: &[u8], b: &[u8]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return f32::INFINITY;
    }
    let sum: i64 = a
        .iter()
        .zip(b)
        .map(|(x, y)| (i64::from(*x) - i64::from(*y)).abs())
        .sum();
    sum as f32 / a.len() as f32
}

/// How far the tone window flexes on face-count evidence (zero counts carry
/// none — detectors miss small faces in wide shots and blurred ones).
fn face_aware_window(a: Option<u32>, b: Option<u32>) -> f32 {
    let (Some(a), Some(b)) = (a, b) else {
        return SIGNATURE_WINDOW;
    };
    if a == 0 || b == 0 {
        return SIGNATURE_WINDOW;
    }
    match a.abs_diff(b) {
        0 => SIGNATURE_WINDOW + 4.0,
        1 => SIGNATURE_WINDOW + 3.0,
        _ if a.min(b) <= 1 => 20.0,
        _ => SIGNATURE_WINDOW - 3.0,
    }
}

/// Signed same-moment weight: positive means "one moment", magnitude is
/// confidence.
pub fn pair_weight(a: &MediaFeatures, b: &MediaFeatures) -> f32 {
    // Clips stand alone.
    if !a.is_image || !b.is_image {
        return f32::NEG_INFINITY;
    }
    // Both dated: the clock decides, decisively in both directions.
    if let (Some(ta), Some(tb)) = (a.captured_at, b.captured_at) {
        let dt = (ta - tb).abs() as f64;
        return (3.0 * (GROUP_WINDOW - dt) / GROUP_WINDOW) as f32;
    }
    let mut w = 0.0f32;
    let mut evidence = false;
    if let (Some(ea), Some(eb)) = (&a.embedding, &b.embedding) {
        evidence = true;
        w += (dot(ea, eb) - SCENE_MID) / SCENE_HALF;
        if !a.faces.is_empty() && !b.faces.is_empty() {
            let f = (best_face_match(&a.faces, &b.faces) - FACE_TH) * FACE_GAIN;
            w += f.clamp(0.0, FACE_CAP);
        }
    }
    if let (Some(sa), Some(sb)) = (&a.signature, &b.signature) {
        evidence = true;
        let window = face_aware_window(a.face_count, b.face_count);
        w += W_TONE * (window - signature_distance(sa, sb)) / SIGNATURE_WINDOW;
    }
    // No evidence either way: don't group blind.
    if evidence { w } else { -1.0 }
}

/// Cluster items into moments. `ids` are stable per-item identifiers (file
/// paths) used only for deterministic tie-breaking; the result is indices
/// into the input, each cluster sorted, clusters ordered by first member.
pub fn group_moments(items: &[MediaFeatures], ids: &[String]) -> Vec<Vec<usize>> {
    let n = items.len();
    if n == 0 {
        return Vec::new();
    }
    let mut w = vec![vec![0.0f32; n]; n];
    for i in 0..n {
        for j in (i + 1)..n {
            let v = pair_weight(&items[i], &items[j]);
            w[i][j] = v;
            w[j][i] = v;
        }
    }
    let key = |c: &[usize]| -> String {
        let mut parts: Vec<&str> = c.iter().map(|&i| ids[i].as_str()).collect();
        parts.sort_unstable();
        parts.join("\u{0}")
    };
    let mean_w = |a: &[usize], b: &[usize]| -> f32 {
        let mut sum = 0.0f32;
        for &x in a {
            for &y in b {
                sum += w[x][y];
            }
        }
        sum / (a.len() * b.len()) as f32
    };

    let mut clusters: Vec<Vec<usize>> = (0..n).map(|i| vec![i]).collect();
    // Merge phase: global argmax of mean cross-pair weight, stop at zero.
    loop {
        let mut best: Option<(f32, usize, usize, String)> = None;
        for x in 0..clusters.len() {
            for y in (x + 1)..clusters.len() {
                if clusters[x].len() + clusters[y].len() > GROUP_SIZE {
                    continue;
                }
                let m = mean_w(&clusters[x], &clusters[y]);
                if m <= 1e-9 {
                    continue;
                }
                let merged: Vec<usize> =
                    clusters[x].iter().chain(&clusters[y]).copied().collect();
                let k = key(&merged);
                let better = match &best {
                    None => true,
                    Some((bm, ..)) if m > bm + 1e-12 => true,
                    Some((bm, _, _, bk)) => (m - bm).abs() <= 1e-12 && k < *bk,
                };
                if better {
                    best = Some((m, x, y, k));
                }
            }
        }
        let Some((_, x, y, _)) = best else { break };
        let taken = clusters.remove(y);
        clusters[x].extend(taken);
    }
    // BOEM: move single items wherever the global objective improves, walked
    // in stable-id order to a fixpoint — undoes early merges that captured
    // an item before its true group existed.
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| ids[a].cmp(&ids[b]));
    for _ in 0..20 {
        let mut moved = false;
        for &p in &order {
            let ci = clusters.iter().position(|c| c.contains(&p)).expect("member");
            let cur: f32 = clusters[ci].iter().filter(|&&q| q != p).map(|&q| w[p][q]).sum();
            let mut best_gain = 1e-12f32;
            let mut best_to: Option<isize> = None;
            for (cj, c) in clusters.iter().enumerate() {
                if cj == ci || c.len() >= GROUP_SIZE {
                    continue;
                }
                let g: f32 = c.iter().map(|&q| w[p][q]).sum::<f32>() - cur;
                if g > best_gain {
                    best_gain = g;
                    best_to = Some(cj as isize);
                }
            }
            if clusters[ci].len() > 1 && -cur > best_gain {
                best_to = Some(-1);
            }
            if let Some(to) = best_to {
                clusters[ci].retain(|&q| q != p);
                if to < 0 {
                    clusters.push(vec![p]);
                } else {
                    clusters[to as usize].push(p);
                }
                clusters.retain(|c| !c.is_empty());
                moved = true;
            }
        }
        if !moved {
            break;
        }
    }
    for c in &mut clusters {
        c.sort_unstable();
    }
    clusters.sort_by_key(|c| c[0]);
    clusters
}

#[cfg(test)]
mod tests {
    use super::*;

    fn photo(embedding: Vec<f32>) -> MediaFeatures {
        MediaFeatures {
            is_image: true,
            embedding: Some(embedding),
            ..Default::default()
        }
    }

    /// Two tight pairs and a loner, in any order, must cluster identically.
    #[test]
    fn shuffling_the_input_changes_nothing() {
        // Orthogonal-ish unit vectors: a-pair similar, b-pair similar.
        let a1 = photo(vec![1.0, 0.0, 0.0]);
        let a2 = photo(vec![0.99, 0.14, 0.0]);
        let b1 = photo(vec![0.0, 1.0, 0.0]);
        let b2 = photo(vec![0.14, 0.99, 0.0]);
        let lone = photo(vec![0.0, 0.0, 1.0]);
        let items = [a1, a2, b1, b2, lone];
        let ids: Vec<String> = ["a1", "a2", "b1", "b2", "z"].iter().map(|s| s.to_string()).collect();

        let base = group_moments(&items, &ids);
        let as_sets = |cl: &[Vec<usize>], order: &[usize]| -> Vec<Vec<usize>> {
            let mut v: Vec<Vec<usize>> = cl
                .iter()
                .map(|c| {
                    let mut m: Vec<usize> = c.iter().map(|&i| order[i]).collect();
                    m.sort_unstable();
                    m
                })
                .collect();
            v.sort();
            v
        };
        let expect = as_sets(&base, &[0, 1, 2, 3, 4]);

        let order = [3usize, 0, 4, 2, 1];
        let shuffled: Vec<MediaFeatures> = order.iter().map(|&i| items[i].clone()).collect();
        let sids: Vec<String> = order.iter().map(|&i| ids[i].clone()).collect();
        let got = as_sets(&group_moments(&shuffled, &sids), &order);
        assert_eq!(expect, got);
        assert_eq!(expect, vec![vec![0, 1], vec![2, 3], vec![4]]);
    }

    /// Dated photos group by the clock and never chain past the window.
    #[test]
    fn dated_pairs_use_time() {
        let at = |t: i64| MediaFeatures {
            is_image: true,
            captured_at: Some(t),
            ..Default::default()
        };
        let items = [at(0), at(30), at(1000)];
        let ids: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let got = group_moments(&items, &ids);
        assert_eq!(got, vec![vec![0, 1], vec![2]]);
    }

    /// A clip never joins anything.
    #[test]
    fn clips_stand_alone() {
        let clip = MediaFeatures { is_image: false, ..Default::default() };
        let items = [photo(vec![1.0, 0.0]), photo(vec![1.0, 0.0]), clip];
        let ids: Vec<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        let got = group_moments(&items, &ids);
        assert!(got.contains(&vec![0, 1]));
        assert!(got.contains(&vec![2]));
    }
}
