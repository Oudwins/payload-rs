//! `Array.prototype.sort` with a comparator, as V8 implements it
//! (third_party/v8/builtins/array-sort.tq: TimSort with binary insertion sort for short runs
//! and galloping merges). With a consistent comparator any stable sort gives the same order;
//! with an inconsistent one (e.g. a comparator returning `0` for some pairs, or `NaN`) only the
//! exact algorithm reproduces V8's result.

const MIN_GALLOP_WINS: usize = 7;

/// Sorts `items` in place like `items.sort(compare)` in V8. `compare(a, b)` returns the
/// comparator's numeric result; `NaN` counts as `0`.
pub fn v8_sort<T: Clone>(items: &mut [T], compare: impl FnMut(&T, &T) -> f64) {
  let mut state = State { compare, min_gallop: MIN_GALLOP_WINS, runs: Vec::new() };
  state.sort(items);
}

struct State<F> {
  compare: F,
  min_gallop: usize,
  /// pending runs as (base, length)
  runs: Vec<(usize, usize)>,
}

impl<F> State<F> {
  /// `sortState.Compare(x, y)`: `< 0`, `== 0` or `> 0`, `NaN` as `0`.
  fn cmp<T>(&mut self, x: &T, y: &T) -> f64
  where
    F: FnMut(&T, &T) -> f64,
  {
    let v = (self.compare)(x, y);
    if v.is_nan() { 0.0 } else { v }
  }

  fn sort<T: Clone>(&mut self, a: &mut [T])
  where
    F: FnMut(&T, &T) -> f64,
  {
    let length = a.len();
    if length < 2 {
      return;
    }
    let mut remaining = length;
    let mut low = 0;
    let min_run_length = compute_min_run_length(remaining);
    while remaining != 0 {
      let mut current_run_length = self.count_and_make_run(a, low, low + remaining);
      if current_run_length < min_run_length {
        let forced_run_length = min_run_length.min(remaining);
        self.binary_insertion_sort(a, low, low + current_run_length, low + forced_run_length);
        current_run_length = forced_run_length;
      }
      self.runs.push((low, current_run_length));
      self.merge_collapse(a);
      low += current_run_length;
      remaining -= current_run_length;
    }
    self.merge_force_collapse(a);
  }

  fn binary_insertion_sort<T: Clone>(&mut self, a: &mut [T], low: usize, start_arg: usize, high: usize)
  where
    F: FnMut(&T, &T) -> f64,
  {
    let mut start = if low == start_arg { start_arg + 1 } else { start_arg };
    while start < high {
      let mut left = low;
      let mut right = start;
      let pivot = a[start].clone();
      while left < right {
        let mid = left + ((right - left) >> 1);
        let order = self.cmp(&pivot, &a[mid]);
        if order < 0.0 {
          right = mid;
        } else {
          left = mid + 1;
        }
      }
      let mut p = start;
      while p > left {
        a[p] = a[p - 1].clone();
        p -= 1;
      }
      a[left] = pivot;
      start += 1;
    }
  }

  fn count_and_make_run<T: Clone>(&mut self, a: &mut [T], low_arg: usize, high: usize) -> usize
  where
    F: FnMut(&T, &T) -> f64,
  {
    let low = low_arg + 1;
    if low == high {
      return 1;
    }
    let mut run_length = 2;
    let element_low = a[low].clone();
    let element_low_pre = a[low - 1].clone();
    let mut order = self.cmp(&element_low, &element_low_pre);
    let is_descending = order < 0.0;
    let mut previous = element_low;
    for idx in low + 1..high {
      let current = a[idx].clone();
      order = self.cmp(&current, &previous);
      if is_descending {
        if order >= 0.0 {
          break;
        }
      } else if order < 0.0 {
        break;
      }
      previous = current;
      run_length += 1;
    }
    if is_descending {
      a[low_arg..low_arg + run_length].reverse();
    }
    run_length
  }

  fn merge_collapse<T: Clone>(&mut self, a: &mut [T])
  where
    F: FnMut(&T, &T) -> f64,
  {
    while self.runs.len() > 1 {
      let mut n = self.runs.len() - 2;
      if !self.run_invariant_established(n + 1) || !self.run_invariant_established(n) {
        if self.runs[n - 1].1 < self.runs[n + 1].1 {
          n -= 1;
        }
        self.merge_at(a, n);
      } else if self.runs[n].1 <= self.runs[n + 1].1 {
        self.merge_at(a, n);
      } else {
        break;
      }
    }
  }

  fn run_invariant_established(&self, n: usize) -> bool {
    if n < 2 {
      return true;
    }
    self.runs[n - 2].1 > self.runs[n - 1].1 + self.runs[n].1
  }

  fn merge_force_collapse<T: Clone>(&mut self, a: &mut [T])
  where
    F: FnMut(&T, &T) -> f64,
  {
    while self.runs.len() > 1 {
      let mut n = self.runs.len() - 2;
      if n > 0 && self.runs[n - 1].1 < self.runs[n + 1].1 {
        n -= 1;
      }
      self.merge_at(a, n);
    }
  }

  fn merge_at<T: Clone>(&mut self, a: &mut [T], i: usize)
  where
    F: FnMut(&T, &T) -> f64,
  {
    let (mut base_a, mut length_a) = self.runs[i];
    let (base_b, mut length_b) = self.runs[i + 1];
    self.runs[i].1 = length_a + length_b;
    self.runs.remove(i + 1);

    let key_right = a[base_b].clone();
    let k = self.gallop_right(&a[..], &key_right, base_a, length_a, 0);
    base_a += k;
    length_a -= k;
    if length_a == 0 {
      return;
    }
    let key_left = a[base_a + length_a - 1].clone();
    length_b = self.gallop_left(&a[..], &key_left, base_b, length_b, length_b - 1);
    if length_b == 0 {
      return;
    }
    if length_a <= length_b {
      self.merge_low(a, base_a, length_a, base_b, length_b);
    } else {
      self.merge_high(a, base_a, length_a, base_b, length_b);
    }
  }

  /// Leftmost position in the sorted run `array[base..base + length]` where `key` belongs.
  fn gallop_left<T>(&mut self, array: &[T], key: &T, base: usize, length: usize, hint: usize) -> usize
  where
    F: FnMut(&T, &T) -> f64,
  {
    let mut last_ofs: isize = 0;
    let mut offset: isize = 1;
    let hint_i = hint as isize;
    let order = self.cmp(&array[base + hint], key);
    if order < 0.0 {
      let max_ofs = (length - hint) as isize;
      while offset < max_ofs {
        let order = self.cmp(&array[base + hint + offset as usize], key);
        if order >= 0.0 {
          break;
        }
        last_ofs = offset;
        offset = (offset << 1) + 1;
        if offset <= 0 {
          offset = max_ofs;
        }
      }
      if offset > max_ofs {
        offset = max_ofs;
      }
      last_ofs += hint_i;
      offset += hint_i;
    } else {
      let max_ofs = hint_i + 1;
      while offset < max_ofs {
        let order = self.cmp(&array[base + (hint_i - offset) as usize], key);
        if order < 0.0 {
          break;
        }
        last_ofs = offset;
        offset = (offset << 1) + 1;
        if offset <= 0 {
          offset = max_ofs;
        }
      }
      if offset > max_ofs {
        offset = max_ofs;
      }
      let tmp = last_ofs;
      last_ofs = hint_i - offset;
      offset = hint_i - tmp;
    }
    last_ofs += 1;
    while last_ofs < offset {
      let m = last_ofs + ((offset - last_ofs) >> 1);
      let order = self.cmp(&array[base + m as usize], key);
      if order < 0.0 {
        last_ofs = m + 1;
      } else {
        offset = m;
      }
    }
    offset as usize
  }

  /// Rightmost position in the sorted run `array[base..base + length]` where `key` belongs.
  fn gallop_right<T>(&mut self, array: &[T], key: &T, base: usize, length: usize, hint: usize) -> usize
  where
    F: FnMut(&T, &T) -> f64,
  {
    let mut last_ofs: isize = 0;
    let mut offset: isize = 1;
    let hint_i = hint as isize;
    let order = self.cmp(key, &array[base + hint]);
    if order < 0.0 {
      let max_ofs = hint_i + 1;
      while offset < max_ofs {
        let order = self.cmp(key, &array[base + (hint_i - offset) as usize]);
        if order >= 0.0 {
          break;
        }
        last_ofs = offset;
        offset = (offset << 1) + 1;
        if offset <= 0 {
          offset = max_ofs;
        }
      }
      if offset > max_ofs {
        offset = max_ofs;
      }
      let tmp = last_ofs;
      last_ofs = hint_i - offset;
      offset = hint_i - tmp;
    } else {
      let max_ofs = (length - hint) as isize;
      while offset < max_ofs {
        let order = self.cmp(key, &array[base + hint + offset as usize]);
        if order < 0.0 {
          break;
        }
        last_ofs = offset;
        offset = (offset << 1) + 1;
        if offset <= 0 {
          offset = max_ofs;
        }
      }
      if offset > max_ofs {
        offset = max_ofs;
      }
      last_ofs += hint_i;
      offset += hint_i;
    }
    last_ofs += 1;
    while last_ofs < offset {
      let m = last_ofs + ((offset - last_ofs) >> 1);
      let order = self.cmp(key, &array[base + m as usize]);
      if order < 0.0 {
        offset = m;
      } else {
        last_ofs = m + 1;
      }
    }
    offset as usize
  }

  fn merge_low<T: Clone>(&mut self, a: &mut [T], base_a: usize, length_a_arg: usize, base_b: usize, length_b_arg: usize)
  where
    F: FnMut(&T, &T) -> f64,
  {
    let mut length_a = length_a_arg;
    let mut length_b = length_b_arg;
    let temp: Vec<T> = a[base_a..base_a + length_a].to_vec();
    let mut dest = base_a;
    let mut cursor_temp = 0;
    let mut cursor_b = base_b;

    a[dest] = a[cursor_b].clone();
    dest += 1;
    cursor_b += 1;

    enum Exit {
      Succeed,
      CopyB,
    }
    let exit = 'merge: {
      length_b -= 1;
      if length_b == 0 {
        break 'merge Exit::Succeed;
      }
      if length_a == 1 {
        break 'merge Exit::CopyB;
      }
      let mut min_gallop = self.min_gallop;
      loop {
        let mut wins_a = 0;
        let mut wins_b = 0;
        loop {
          let order = self.cmp(&a[cursor_b], &temp[cursor_temp]);
          if order < 0.0 {
            a[dest] = a[cursor_b].clone();
            dest += 1;
            cursor_b += 1;
            wins_b += 1;
            length_b -= 1;
            wins_a = 0;
            if length_b == 0 {
              break 'merge Exit::Succeed;
            }
            if wins_b >= min_gallop {
              break;
            }
          } else {
            a[dest] = temp[cursor_temp].clone();
            dest += 1;
            cursor_temp += 1;
            wins_a += 1;
            length_a -= 1;
            wins_b = 0;
            if length_a == 1 {
              break 'merge Exit::CopyB;
            }
            if wins_a >= min_gallop {
              break;
            }
          }
        }
        min_gallop += 1;
        let mut first_iteration = true;
        while wins_a >= MIN_GALLOP_WINS || wins_b >= MIN_GALLOP_WINS || first_iteration {
          first_iteration = false;
          min_gallop = min_gallop.saturating_sub(1).max(1);
          self.min_gallop = min_gallop;

          let key = a[cursor_b].clone();
          wins_a = self.gallop_right(&temp, &key, cursor_temp, length_a, 0);
          if wins_a > 0 {
            a[dest..dest + wins_a].clone_from_slice(&temp[cursor_temp..cursor_temp + wins_a]);
            dest += wins_a;
            cursor_temp += wins_a;
            length_a -= wins_a;
            if length_a == 1 {
              break 'merge Exit::CopyB;
            }
            // impossible with a consistent comparator
            if length_a == 0 {
              break 'merge Exit::Succeed;
            }
          }
          a[dest] = a[cursor_b].clone();
          dest += 1;
          cursor_b += 1;
          length_b -= 1;
          if length_b == 0 {
            break 'merge Exit::Succeed;
          }

          let key = temp[cursor_temp].clone();
          wins_b = self.gallop_left(&a[..], &key, cursor_b, length_b, 0);
          if wins_b > 0 {
            for i in 0..wins_b {
              a[dest + i] = a[cursor_b + i].clone();
            }
            dest += wins_b;
            cursor_b += wins_b;
            length_b -= wins_b;
            if length_b == 0 {
              break 'merge Exit::Succeed;
            }
          }
          a[dest] = temp[cursor_temp].clone();
          dest += 1;
          cursor_temp += 1;
          length_a -= 1;
          if length_a == 1 {
            break 'merge Exit::CopyB;
          }
        }
        min_gallop += 1;
        self.min_gallop = min_gallop;
      }
    };
    match exit {
      Exit::Succeed => {
        if length_a > 0 {
          a[dest..dest + length_a].clone_from_slice(&temp[cursor_temp..cursor_temp + length_a]);
        }
      }
      Exit::CopyB => {
        // the last element of run A belongs at the end of the merge
        for i in 0..length_b {
          a[dest + i] = a[cursor_b + i].clone();
        }
        a[dest + length_b] = temp[cursor_temp].clone();
      }
    }
  }

  fn merge_high<T: Clone>(&mut self, a: &mut [T], base_a: usize, length_a_arg: usize, base_b: usize, length_b_arg: usize)
  where
    F: FnMut(&T, &T) -> f64,
  {
    let mut length_a = length_a_arg;
    let mut length_b = length_b_arg;
    let temp: Vec<T> = a[base_b..base_b + length_b].to_vec();
    // indices can step to -1 at the very end (`dest`, `cursor_a`, `cursor_temp`)
    let mut dest = (base_b + length_b - 1) as isize;
    let mut cursor_temp = length_b as isize - 1;
    let mut cursor_a = (base_a + length_a - 1) as isize;

    a[dest as usize] = a[cursor_a as usize].clone();
    dest -= 1;
    cursor_a -= 1;

    enum Exit {
      Succeed,
      CopyA,
    }
    let exit = 'merge: {
      length_a -= 1;
      if length_a == 0 {
        break 'merge Exit::Succeed;
      }
      if length_b == 1 {
        break 'merge Exit::CopyA;
      }
      let mut min_gallop = self.min_gallop;
      loop {
        let mut wins_a = 0;
        let mut wins_b = 0;
        loop {
          let order = self.cmp(&temp[cursor_temp as usize], &a[cursor_a as usize]);
          if order < 0.0 {
            a[dest as usize] = a[cursor_a as usize].clone();
            dest -= 1;
            cursor_a -= 1;
            wins_a += 1;
            length_a -= 1;
            wins_b = 0;
            if length_a == 0 {
              break 'merge Exit::Succeed;
            }
            if wins_a >= min_gallop {
              break;
            }
          } else {
            a[dest as usize] = temp[cursor_temp as usize].clone();
            dest -= 1;
            cursor_temp -= 1;
            wins_b += 1;
            length_b -= 1;
            wins_a = 0;
            if length_b == 1 {
              break 'merge Exit::CopyA;
            }
            if wins_b >= min_gallop {
              break;
            }
          }
        }
        min_gallop += 1;
        let mut first_iteration = true;
        while wins_a >= MIN_GALLOP_WINS || wins_b >= MIN_GALLOP_WINS || first_iteration {
          first_iteration = false;
          min_gallop = min_gallop.saturating_sub(1).max(1);
          self.min_gallop = min_gallop;

          let key = temp[cursor_temp as usize].clone();
          let k = self.gallop_right(&a[..], &key, base_a, length_a, length_a - 1);
          wins_a = length_a - k;
          if wins_a > 0 {
            dest -= wins_a as isize;
            cursor_a -= wins_a as isize;
            for i in (0..wins_a).rev() {
              a[(dest + 1) as usize + i] = a[(cursor_a + 1) as usize + i].clone();
            }
            length_a -= wins_a;
            if length_a == 0 {
              break 'merge Exit::Succeed;
            }
          }
          a[dest as usize] = temp[cursor_temp as usize].clone();
          dest -= 1;
          cursor_temp -= 1;
          length_b -= 1;
          if length_b == 1 {
            break 'merge Exit::CopyA;
          }

          let key = a[cursor_a as usize].clone();
          let k = self.gallop_left(&temp, &key, 0, length_b, length_b - 1);
          wins_b = length_b - k;
          if wins_b > 0 {
            dest -= wins_b as isize;
            cursor_temp -= wins_b as isize;
            for i in 0..wins_b {
              a[(dest + 1) as usize + i] = temp[(cursor_temp + 1) as usize + i].clone();
            }
            length_b -= wins_b;
            if length_b == 1 {
              break 'merge Exit::CopyA;
            }
            // impossible with a consistent comparator
            if length_b == 0 {
              break 'merge Exit::Succeed;
            }
          }
          a[dest as usize] = a[cursor_a as usize].clone();
          dest -= 1;
          cursor_a -= 1;
          length_a -= 1;
          if length_a == 0 {
            break 'merge Exit::Succeed;
          }
        }
        min_gallop += 1;
        self.min_gallop = min_gallop;
      }
    };
    match exit {
      Exit::Succeed => {
        if length_b > 0 {
          let start = (dest - (length_b as isize - 1)) as usize;
          a[start..start + length_b].clone_from_slice(&temp[..length_b]);
        }
      }
      Exit::CopyA => {
        // the first element of run B belongs at the front of the merge
        dest -= length_a as isize;
        cursor_a -= length_a as isize;
        for i in (0..length_a).rev() {
          a[(dest + 1) as usize + i] = a[(cursor_a + 1) as usize + i].clone();
        }
        a[dest as usize] = temp[cursor_temp as usize].clone();
      }
    }
  }
}

fn compute_min_run_length(n_arg: usize) -> usize {
  let mut n = n_arg;
  let mut r = 0;
  while n >= 64 {
    r |= n & 1;
    n >>= 1;
  }
  n + r
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn sorts_consistently_and_stably() {
    let mut items: Vec<(i32, usize)> = (0..500).map(|i| (((i * 7919) % 97) as i32, i)).collect();
    v8_sort(&mut items, |a, b| f64::from(a.0 - b.0));
    for w in items.windows(2) {
      assert!(w[0].0 < w[1].0 || (w[0].0 == w[1].0 && w[0].1 < w[1].1));
    }
  }
}
