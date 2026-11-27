//! The virtual keyboard's xkb keymap and modifier state. wlroots does not derive modifiers from a
//! virtual keyboard's keys, so the helper tracks them with xkbcommon and sends them itself.

use xkbcommon::xkb;

/// evdev codes are offset by 8 in xkb.
const EVDEV_OFFSET: u32 = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Modifiers {
    pub depressed: u32,
    pub latched: u32,
    pub locked: u32,
    pub group: u32,
}

pub struct Keyboard {
    keymap_text: String,
    state: xkb::State,
    modifiers: Modifiers,
}

impl Keyboard {
    pub fn new(
        layout: &str,
        variant: &str,
        model: &str,
        options: &str,
    ) -> Result<Keyboard, String> {
        let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let options = (!options.is_empty()).then(|| options.to_string());
        let keymap = xkb::Keymap::new_from_names(
            &context,
            "evdev",
            model,
            layout,
            variant,
            options,
            xkb::KEYMAP_COMPILE_NO_FLAGS,
        )
        .ok_or_else(|| format!("unknown keyboard layout '{layout}' variant '{variant}'"))?;
        let keymap_text = keymap.get_as_string(xkb::KEYMAP_FORMAT_TEXT_V1);
        let state = xkb::State::new(&keymap);
        Ok(Keyboard {
            keymap_text,
            state,
            modifiers: Modifiers::default(),
        })
    }

    /// The keymap in the text format `zwp_virtual_keyboard_v1.keymap` takes.
    pub fn keymap_text(&self) -> &str {
        &self.keymap_text
    }

    /// Updates the state for an evdev key; returns the modifiers when they changed.
    pub fn key(&mut self, code: u32, pressed: bool) -> Option<Modifiers> {
        let direction = if pressed {
            xkb::KeyDirection::Down
        } else {
            xkb::KeyDirection::Up
        };
        self.state
            .update_key((code + EVDEV_OFFSET).into(), direction);
        let modifiers = Modifiers {
            depressed: self.state.serialize_mods(xkb::STATE_MODS_DEPRESSED),
            latched: self.state.serialize_mods(xkb::STATE_MODS_LATCHED),
            locked: self.state.serialize_mods(xkb::STATE_MODS_LOCKED),
            group: self.state.serialize_layout(xkb::STATE_LAYOUT_EFFECTIVE),
        };
        (modifiers != self.modifiers).then(|| {
            self.modifiers = modifiers;
            modifiers
        })
    }

    #[cfg(test)]
    fn keysym_name(&self, code: u32) -> String {
        xkb::keysym_get_name(self.state.key_get_one_sym((code + EVDEV_OFFSET).into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_LEFTSHIFT: u32 = 42;
    const KEY_CAPSLOCK: u32 = 58;
    const KEY_A: u32 = 30;
    const KEY_BACKSLASH: u32 = 43;

    #[test]
    fn compiles_the_users_layout() {
        let us = Keyboard::new("us", "", "", "").unwrap();
        let gb = Keyboard::new("gb", "", "", "").unwrap();
        assert!(gb.keymap_text().contains("xkb_keymap"));
        assert_eq!(us.keysym_name(KEY_BACKSLASH), "backslash");
        assert_eq!(gb.keysym_name(KEY_BACKSLASH), "numbersign");
    }

    #[test]
    fn rejects_unknown_layouts() {
        assert!(Keyboard::new("no-such-layout", "", "", "").is_err());
    }

    #[test]
    fn reports_modifier_changes_only() {
        let mut keyboard = Keyboard::new("us", "", "", "").unwrap();
        let shift = keyboard.key(KEY_LEFTSHIFT, true).expect("shift down");
        assert_ne!(shift.depressed, 0);
        assert_eq!(keyboard.key(KEY_A, true), None);
        assert_eq!(keyboard.key(KEY_A, false), None);
        assert_eq!(
            keyboard.key(KEY_LEFTSHIFT, false).map(|m| m.depressed),
            Some(0)
        );

        keyboard.key(KEY_CAPSLOCK, true);
        keyboard.key(KEY_CAPSLOCK, false);
        assert_ne!(keyboard.modifiers.locked, 0, "caps lock stays locked");
    }
}
