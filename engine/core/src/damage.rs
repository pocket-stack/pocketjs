//! Backend-independent DrawList damage tracking.
//!
//! A [`DamageTracker`] snapshots the DrawList whose pixels currently live in
//! one persistent render target. On the next frame it compares operations in
//! order, adds both the old and new conservative bounds for changed
//! operations, and returns a small set of disjoint rectangles. Backends must
//! clear each returned rectangle and replay the complete current DrawList
//! clipped to that rectangle so painter order and translucent overlays remain
//! correct.
//!
//! Inserted, removed, or type-changed operations are conservatively aligned
//! against exact nearby anchors. Every unmatched old and new bound is damaged;
//! structural churn therefore stays partial without assuming node identity.
//!
//! Keep one tracker per physical framebuffer. Core-managed texture, font and
//! style mutations are detected through [`Ui::raster_revision`]. Hosts must
//! still call [`DamageTracker::invalidate`] for output-affecting mutations
//! performed outside `Ui`.

use alloc::vec::Vec;

use crate::drawlist::{self, Op};
use crate::Ui;

const STRUCTURE_RESYNC_OPS: usize = 32;

/// Default fixed capacity used by the generic software rasterizer.
pub const DEFAULT_DAMAGE_REGIONS: usize = 8;

/// Failure to plan damage for a persistent target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum DamageError {
    InvalidCapacity,
    InvalidPolicy,
    InvalidTarget,
    MalformedDrawList,
}

/// Integer logical-pixel rectangle with half-open bounds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DamageRect {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
}

impl DamageRect {
    pub const fn new(x0: i32, y0: i32, x1: i32, y1: i32) -> Self {
        Self { x0, y0, x1, y1 }
    }

    pub const fn empty() -> Self {
        Self {
            x0: i32::MAX,
            y0: i32::MAX,
            x1: i32::MIN,
            y1: i32::MIN,
        }
    }

    pub fn intersect(self, other: Self) -> Self {
        Self {
            x0: self.x0.max(other.x0),
            y0: self.y0.max(other.y0),
            x1: self.x1.min(other.x1),
            y1: self.y1.min(other.y1),
        }
    }

    pub fn union(self, other: Self) -> Self {
        if self.is_empty() {
            return other;
        }
        if other.is_empty() {
            return self;
        }
        Self {
            x0: self.x0.min(other.x0),
            y0: self.y0.min(other.y0),
            x1: self.x1.max(other.x1),
            y1: self.y1.max(other.y1),
        }
    }

    pub fn is_empty(self) -> bool {
        self.x0 >= self.x1 || self.y0 >= self.y1
    }

    pub fn area(self) -> u64 {
        if self.is_empty() {
            0
        } else {
            (self.x1 - self.x0) as u64 * (self.y1 - self.y0) as u64
        }
    }

    fn touches(self, other: Self) -> bool {
        !self.is_empty()
            && !other.is_empty()
            && self.x0 <= other.x1
            && other.x0 <= self.x1
            && self.y0 <= other.y1
            && other.y0 <= self.y1
    }
}

impl Default for DamageRect {
    fn default() -> Self {
        Self::empty()
    }
}

/// Backend policy for promoting accumulated damage to a full redraw.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DamagePolicy {
    /// Promote when damaged area reaches this percentage of the viewport.
    /// Valid values are 1 through 100.
    pub full_redraw_percent: u8,
}

impl DamagePolicy {
    pub const fn new(full_redraw_percent: u8) -> Self {
        Self {
            full_redraw_percent,
        }
    }

    fn is_valid(self) -> bool {
        (1..=100).contains(&self.full_redraw_percent)
    }
}

impl Default for DamagePolicy {
    fn default() -> Self {
        Self::new(75)
    }
}

/// Physical target identity used to decide when retained pixels are reusable.
///
/// `signature` is backend-defined and must change when pixel format, clear
/// color, sampling contract, or any other output-affecting configuration
/// changes without changing dimensions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DamageTarget {
    pub width: u32,
    pub height: u32,
    pub scale: u32,
    pub signature: u64,
}

impl DamageTarget {
    pub const fn new(width: u32, height: u32, scale: u32, signature: u64) -> Self {
        Self {
            width,
            height,
            scale,
            signature,
        }
    }
}

/// Damage decision for one frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DamagePlan<const MAX_REGIONS: usize = DEFAULT_DAMAGE_REGIONS> {
    rects: [DamageRect; MAX_REGIONS],
    len: usize,
    full_redraw: bool,
    screen: DamageRect,
}

impl<const MAX_REGIONS: usize> DamagePlan<MAX_REGIONS> {
    const fn empty(screen: DamageRect) -> Self {
        Self {
            rects: [DamageRect::empty(); MAX_REGIONS],
            len: 0,
            full_redraw: false,
            screen,
        }
    }

    /// Construct a complete redraw plan for `screen`.
    pub fn full(screen: DamageRect) -> Self {
        let mut damage = Self::empty(screen);
        if MAX_REGIONS > 0 && !screen.is_empty() {
            damage.rects[0] = screen;
            damage.len = 1;
        }
        damage.full_redraw = true;
        damage
    }

    /// Disjoint logical rectangles that must be repainted.
    pub fn regions(&self) -> &[DamageRect] {
        &self.rects[..self.len]
    }

    pub fn region_count(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn area(&self) -> u64 {
        self.regions().iter().map(|rect| rect.area()).sum()
    }

    pub fn bounds(&self) -> DamageRect {
        self.regions()
            .iter()
            .copied()
            .fold(DamageRect::empty(), DamageRect::union)
    }

    pub fn is_full_redraw(&self) -> bool {
        self.full_redraw
    }

    /// Apply a backend-selected full-redraw threshold.
    pub fn with_policy(mut self, policy: DamagePolicy) -> Result<Self, DamageError> {
        if !policy.is_valid() {
            return Err(DamageError::InvalidPolicy);
        }
        if !self.full_redraw && self.should_promote_to_full(self.screen, policy) {
            self = Self::full(self.screen);
        }
        Ok(self)
    }

    fn should_promote_to_full(&self, screen: DamageRect, policy: DamagePolicy) -> bool {
        let screen_area = screen.area();
        !self.is_empty()
            && screen_area > 0
            && self.area().saturating_mul(100)
                >= screen_area.saturating_mul(policy.full_redraw_percent as u64)
    }

    fn add(&mut self, rect: DamageRect, screen: DamageRect) {
        let mut merged = rect.intersect(screen);
        if merged.is_empty() {
            return;
        }

        let mut index = 0usize;
        while index < self.len {
            if merged.touches(self.rects[index]) {
                merged = merged.union(self.rects[index]);
                self.remove(index);
                index = 0;
            } else {
                index += 1;
            }
        }

        if self.len < MAX_REGIONS {
            self.rects[self.len] = merged;
            self.len += 1;
            return;
        }

        let mut best = 0usize;
        let mut best_inflation = u64::MAX;
        for (candidate, &existing) in self.regions().iter().enumerate() {
            let union = existing.union(merged);
            let inflation = union
                .area()
                .saturating_sub(existing.area())
                .saturating_sub(merged.area());
            if inflation < best_inflation {
                best = candidate;
                best_inflation = inflation;
            }
        }
        merged = merged.union(self.rects[best]);
        self.remove(best);
        self.add(merged, screen);
    }

    fn remove(&mut self, index: usize) {
        self.len -= 1;
        self.rects[index] = self.rects[self.len];
        self.rects[self.len] = DamageRect::empty();
    }
}

/// DrawList snapshot associated with one persistent render target.
pub struct DamageTracker<const MAX_REGIONS: usize = DEFAULT_DAMAGE_REGIONS> {
    words: Vec<u32>,
    target: DamageTarget,
    raster_revision: u64,
    valid: bool,
}

impl<const MAX_REGIONS: usize> DamageTracker<MAX_REGIONS> {
    pub const fn new() -> Self {
        Self {
            words: Vec::new(),
            target: DamageTarget::new(0, 0, 0, 0),
            raster_revision: 0,
            valid: false,
        }
    }

    /// Force the next frame to repaint the complete target.
    pub fn invalidate(&mut self) {
        self.valid = false;
    }

    /// Compute damage without modifying the stored snapshot.
    ///
    /// Call [`commit`](Self::commit) only after the returned regions have
    /// successfully been rendered.
    pub fn prepare(
        &self,
        ui: &Ui,
        words: &[u32],
        target: DamageTarget,
    ) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
        if MAX_REGIONS == 0 {
            return Err(DamageError::InvalidCapacity);
        }
        if target.scale == 0 {
            return Err(DamageError::InvalidTarget);
        }
        let screen = target_screen(ui, target)?;
        let full_redraw =
            !self.valid || self.target != target || self.raster_revision != ui.raster_revision();
        let damage = if full_redraw {
            validate_draw_list(ui, words, screen)?;
            DamagePlan::full(screen)
        } else {
            draw_list_damage(ui, &self.words, words, screen)?
        };
        Ok(damage)
    }

    /// Record the DrawList after its [`DamagePlan`] has been rendered.
    pub fn commit(&mut self, ui: &Ui, words: &[u32], target: DamageTarget) {
        if self.words != words {
            self.words.clear();
            self.words.extend_from_slice(words);
        }
        self.target = target;
        self.raster_revision = ui.raster_revision();
        self.valid = true;
    }
}

impl<const MAX_REGIONS: usize> Default for DamageTracker<MAX_REGIONS> {
    fn default() -> Self {
        Self::new()
    }
}

fn target_screen(ui: &Ui, target: DamageTarget) -> Result<DamageRect, DamageError> {
    let (viewport_width, viewport_height) = ui.viewport();
    if viewport_width <= 0.0 || viewport_height <= 0.0 {
        return Err(DamageError::InvalidTarget);
    }
    let logical_width = viewport_width as u32;
    let logical_height = viewport_height as u32;
    if logical_width
        .checked_mul(target.scale)
        .ok_or(DamageError::InvalidTarget)?
        != target.width
        || logical_height
            .checked_mul(target.scale)
            .ok_or(DamageError::InvalidTarget)?
            != target.height
    {
        return Err(DamageError::InvalidTarget);
    }
    Ok(DamageRect::new(
        0,
        0,
        logical_width as i32,
        logical_height as i32,
    ))
}

fn draw_list_damage<const MAX_REGIONS: usize>(
    ui: &Ui,
    previous: &[u32],
    current: &[u32],
    screen: DamageRect,
) -> Result<DamagePlan<MAX_REGIONS>, DamageError> {
    if previous == current {
        return Ok(DamagePlan::empty(screen));
    }

    let old = decode_draw_list(ui, previous, screen)?;
    let new = decode_draw_list(ui, current, screen)?;
    let mut damage = DamagePlan::empty(screen);
    let mut old_index = 0usize;
    let mut new_index = 0usize;
    while old_index < old.len() && new_index < new.len() {
        let old_op = &old[old_index];
        let new_op = &new[new_index];
        if decoded_ops_equal(old_op, new_op) {
            old_index += 1;
            new_index += 1;
            continue;
        }
        if old_op.code == new_op.code {
            damage.add(old_op.bounds, screen);
            damage.add(new_op.bounds, screen);
            old_index += 1;
            new_index += 1;
            continue;
        }
        if let Some((old_skip, new_skip)) = find_resync_anchor(&old, &new, old_index, new_index) {
            add_op_bounds(&mut damage, &old[old_index..old_index + old_skip], screen);
            add_op_bounds(&mut damage, &new[new_index..new_index + new_skip], screen);
            old_index += old_skip;
            new_index += new_skip;
        } else {
            damage.add(old_op.bounds, screen);
            damage.add(new_op.bounds, screen);
            old_index += 1;
            new_index += 1;
        }
    }
    add_op_bounds(&mut damage, &old[old_index..], screen);
    add_op_bounds(&mut damage, &new[new_index..], screen);
    Ok(damage)
}

fn decode_draw_list<'a>(
    ui: &Ui,
    words: &'a [u32],
    screen: DamageRect,
) -> Result<Vec<Op<'a>>, DamageError> {
    drawlist::decode(ui, words, screen).map_err(|_| DamageError::MalformedDrawList)
}

fn decoded_ops_equal(old: &Op<'_>, new: &Op<'_>) -> bool {
    old.code == new.code && old.bounds == new.bounds && old.words == new.words
}

fn add_op_bounds<const MAX_REGIONS: usize>(
    damage: &mut DamagePlan<MAX_REGIONS>,
    operations: &[Op<'_>],
    screen: DamageRect,
) {
    for operation in operations {
        damage.add(operation.bounds, screen);
    }
}

fn find_resync_anchor(
    old: &[Op<'_>],
    new: &[Op<'_>],
    old_index: usize,
    new_index: usize,
) -> Option<(usize, usize)> {
    let old_count = (old.len() - old_index).min(STRUCTURE_RESYNC_OPS + 1);
    let new_count = (new.len() - new_index).min(STRUCTURE_RESYNC_OPS + 1);
    let mut best: Option<(usize, usize, usize)> = None;
    for old_skip in 0..old_count {
        for new_skip in 0..new_count {
            if old_skip == 0 && new_skip == 0 {
                continue;
            }
            let cost = old_skip + new_skip;
            if best.is_some_and(|(_, _, best_cost)| cost >= best_cost) {
                continue;
            }
            if decoded_ops_equal(&old[old_index + old_skip], &new[new_index + new_skip]) {
                best = Some((old_skip, new_skip, cost));
            }
        }
    }
    best.map(|(old_skip, new_skip, _)| (old_skip, new_skip))
}

fn validate_draw_list(ui: &Ui, words: &[u32], screen: DamageRect) -> Result<(), DamageError> {
    let mut decoder = drawlist::Decoder::new(words, screen);
    while decoder
        .next(ui)
        .map_err(|_| DamageError::MalformedDrawList)?
        .is_some()
    {}
    if decoder.is_balanced() {
        Ok(())
    } else {
        Err(DamageError::MalformedDrawList)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec;

    fn xy_word(x: i16, y: i16) -> u32 {
        x as u16 as u32 | ((y as u16 as u32) << 16)
    }

    fn wh_word(w: u16, h: u16) -> u32 {
        w as u32 | ((h as u32) << 16)
    }

    fn target(width: u32, height: u32, scale: u32) -> DamageTarget {
        DamageTarget::new(width, height, scale, 1)
    }

    fn frame(left: u32, right: u32) -> Vec<u32> {
        vec![
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(32, 16),
            0xff20_1008,
            spec::draw_op::RECT,
            xy_word(2, 4),
            wh_word(4, 4),
            left,
            spec::draw_op::RECT,
            xy_word(26, 4),
            wh_word(4, 4),
            right,
        ]
    }

    #[test]
    fn first_unchanged_and_disjoint_frames_are_classified() {
        let mut ui = Ui::new();
        ui.set_viewport(32.0, 16.0);
        let previous = frame(0xff00_00ff, 0xff00_ff00);
        let current = frame(0xffff_0000, 0xffff_ffff);
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();

        let first = tracker.prepare(&ui, &previous, target(32, 16, 1)).unwrap();
        assert!(first.is_full_redraw());
        assert_eq!(first.area(), 32 * 16);
        tracker.commit(&ui, &previous, target(32, 16, 1));

        let unchanged = tracker.prepare(&ui, &previous, target(32, 16, 1)).unwrap();
        assert!(!unchanged.is_full_redraw());
        assert!(unchanged.is_empty());

        let changed = tracker.prepare(&ui, &current, target(32, 16, 1)).unwrap();
        assert!(!changed.is_full_redraw());
        assert_eq!(changed.region_count(), 2);
        assert_eq!(changed.area(), 32);
    }

    #[test]
    fn structural_removal_retains_partial_damage_but_invalidation_stays_full() {
        let mut ui = Ui::new();
        ui.set_viewport(16.0, 8.0);
        let previous = vec![
            spec::draw_op::RECT,
            xy_word(1, 1),
            wh_word(3, 3),
            0xff00_00ff,
        ];
        let current = Vec::new();
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        tracker.commit(&ui, &previous, target(16, 8, 1));

        let structural = tracker.prepare(&ui, &current, target(16, 8, 1)).unwrap();
        assert!(!structural.is_full_redraw());
        assert_eq!(structural.region_count(), 1);
        assert_eq!(structural.bounds(), DamageRect::new(1, 1, 4, 4));

        tracker.commit(&ui, &current, target(16, 8, 1));
        tracker.invalidate();
        assert!(tracker
            .prepare(&ui, &current, target(16, 8, 1))
            .unwrap()
            .is_full_redraw());

        tracker.commit(&ui, &current, target(16, 8, 1));
        assert!(tracker
            .prepare(&ui, &current, target(32, 16, 2))
            .unwrap()
            .is_full_redraw());

        tracker.commit(&ui, &current, target(32, 16, 2));
        assert!(tracker
            .prepare(&ui, &current, DamageTarget::new(32, 16, 2, 2),)
            .unwrap()
            .is_full_redraw());
    }

    #[test]
    fn structural_resync_preserves_an_exact_common_suffix() {
        let mut ui = Ui::new();
        ui.set_viewport(20.0, 10.0);
        let background = [
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(20, 10),
            0xff10_0804,
        ];
        let suffix = [
            spec::draw_op::RECT,
            xy_word(15, 2),
            wh_word(3, 3),
            0xff00_ff00,
        ];
        let removed = [
            spec::draw_op::GRAD_RECT,
            xy_word(2, 3),
            wh_word(5, 4),
            0xff00_00ff,
            0xffff_0000,
            spec::GradDir::ToRight as u32,
        ];
        let previous = [background.as_slice(), removed.as_slice(), suffix.as_slice()].concat();
        let current = [background.as_slice(), suffix.as_slice()].concat();
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        tracker.commit(&ui, &previous, target(20, 10, 1));

        let damage = tracker.prepare(&ui, &current, target(20, 10, 1)).unwrap();
        assert!(!damage.is_full_redraw());
        assert_eq!(damage.region_count(), 1);
        assert_eq!(damage.bounds(), DamageRect::new(2, 3, 7, 7));
    }

    #[test]
    fn policy_promotes_large_damage_and_rejects_invalid_configuration() {
        let mut ui = Ui::new();
        ui.set_viewport(10.0, 10.0);
        let previous = vec![
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(8, 10),
            0xff00_00ff,
        ];
        let current = vec![
            spec::draw_op::RECT,
            xy_word(0, 0),
            wh_word(8, 10),
            0xff00_ff00,
        ];
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        tracker.commit(&ui, &previous, target(10, 10, 1));
        let plan = tracker
            .prepare(&ui, &current, target(10, 10, 1))
            .unwrap()
            .with_policy(DamagePolicy::new(75))
            .unwrap();
        assert!(plan.is_full_redraw());

        assert_eq!(
            tracker
                .prepare(&ui, &current, target(10, 10, 1))
                .unwrap()
                .with_policy(DamagePolicy::new(0)),
            Err(DamageError::InvalidPolicy)
        );
        let empty_tracker = DamageTracker::<0>::new();
        assert_eq!(
            empty_tracker.prepare(&ui, &current, target(10, 10, 1)),
            Err(DamageError::InvalidCapacity)
        );
    }

    #[test]
    fn malformed_drawlists_are_rejected_and_prepare_does_not_commit() {
        let mut ui = Ui::new();
        ui.set_viewport(16.0, 8.0);
        let previous = vec![
            spec::draw_op::RECT,
            xy_word(1, 1),
            wh_word(3, 3),
            0xff00_00ff,
        ];
        let current = vec![
            spec::draw_op::RECT,
            xy_word(4, 1),
            wh_word(3, 3),
            0xff00_ff00,
        ];
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        tracker.commit(&ui, &previous, target(16, 8, 1));

        let first_plan = tracker.prepare(&ui, &current, target(16, 8, 1)).unwrap();
        let second_plan = tracker.prepare(&ui, &current, target(16, 8, 1)).unwrap();
        assert_eq!(first_plan, second_plan);

        let fresh = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        assert_eq!(
            fresh.prepare(&ui, &[spec::draw_op::RECT, xy_word(0, 0)], target(16, 8, 1),),
            Err(DamageError::MalformedDrawList)
        );
        assert_eq!(
            fresh.prepare(
                &ui,
                &[spec::draw_op::SCISSOR, xy_word(0, 0), wh_word(4, 4),],
                target(16, 8, 1),
            ),
            Err(DamageError::MalformedDrawList)
        );
    }

    #[test]
    fn capacity_merges_regions_and_fractional_viewports_match_raster_semantics() {
        let mut ui = Ui::new();
        ui.set_viewport(30.0, 10.0);
        let frame = |colors: [u32; 3]| {
            let mut words = Vec::new();
            for (index, color) in colors.into_iter().enumerate() {
                words.extend_from_slice(&[
                    spec::draw_op::RECT,
                    xy_word((index * 10 + 1) as i16, 2),
                    wh_word(2, 2),
                    color,
                ]);
            }
            words
        };
        let previous = frame([0xff00_00ff, 0xff00_ff00, 0xffff_0000]);
        let current = frame([0xffff_ffff, 0xff80_8080, 0xff00_0000]);
        let mut tracker = DamageTracker::<2>::new();
        tracker.commit(&ui, &previous, target(30, 10, 1));
        let plan = tracker.prepare(&ui, &current, target(30, 10, 1)).unwrap();
        assert_eq!(plan.region_count(), 2);
        assert!(plan.area() >= 12);

        ui.set_viewport(7.5, 5.5);
        let fractional = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new()
            .prepare(&ui, &[], target(7, 5, 1))
            .unwrap();
        assert!(fractional.is_full_redraw());
    }

    #[test]
    fn default_capacity_merges_a_ninth_disjoint_region() {
        assert_eq!(DEFAULT_DAMAGE_REGIONS, 8);
        let mut ui = Ui::new();
        ui.set_viewport(96.0, 8.0);
        let frame = |color: u32| {
            let mut words = Vec::new();
            for index in 0..9 {
                words.extend_from_slice(&[
                    spec::draw_op::RECT,
                    xy_word((index * 10 + 1) as i16, 2),
                    wh_word(2, 2),
                    color,
                ]);
            }
            words
        };
        let previous = frame(0xff00_00ff);
        let current = frame(0xff00_ff00);
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        tracker.commit(&ui, &previous, target(96, 8, 1));

        let plan = tracker.prepare(&ui, &current, target(96, 8, 1)).unwrap();
        assert!(!plan.is_full_redraw());
        assert_eq!(plan.region_count(), DEFAULT_DAMAGE_REGIONS);
        assert!(plan.area() > 9 * 4);
    }

    #[test]
    fn core_resource_revision_invalidates_unchanged_drawlists() {
        let mut ui = Ui::new();
        ui.set_viewport(4.0, 2.0);
        let mut tracker = DamageTracker::<DEFAULT_DAMAGE_REGIONS>::new();
        tracker.commit(&ui, &[], target(4, 2, 1));
        assert!(tracker
            .prepare(&ui, &[], target(4, 2, 1))
            .unwrap()
            .is_empty());

        assert!(ui.upload_texture(&[0xff, 0xff, 0xff, 0xff], 1, 1, spec::psm::PSM_8888,) >= 0);
        assert!(tracker
            .prepare(&ui, &[], target(4, 2, 1))
            .unwrap()
            .is_full_redraw());
    }
}
