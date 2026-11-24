//! Just enough H.264 bitstream parsing to check what the helper sends.

/// NAL units of an Annex B access unit, without start codes.
pub fn nal_units(access_unit: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= access_unit.len() {
        if access_unit[i..i + 3] == [0, 0, 1] {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    starts
        .iter()
        .enumerate()
        .map(|(n, &start)| {
            let mut end = starts.get(n + 1).map_or(access_unit.len(), |next| next - 3);
            while end > start && access_unit[end - 1] == 0 {
                end -= 1;
            }
            &access_unit[start..end]
        })
        .collect()
}

pub fn nal_type(nal: &[u8]) -> u8 {
    nal[0] & 0x1f
}

struct Bits {
    bytes: Vec<u8>,
    position: usize,
}

impl Bits {
    /// Strips emulation-prevention bytes from a NAL payload.
    fn new(payload: &[u8]) -> Bits {
        let mut bytes = Vec::with_capacity(payload.len());
        let mut zeros = 0;
        for &byte in payload {
            if zeros >= 2 && byte == 3 {
                zeros = 0;
                continue;
            }
            zeros = if byte == 0 { zeros + 1 } else { 0 };
            bytes.push(byte);
        }
        Bits { bytes, position: 0 }
    }

    fn bit(&mut self) -> u32 {
        let byte = self.bytes[self.position / 8];
        let bit = (byte >> (7 - self.position % 8)) & 1;
        self.position += 1;
        bit as u32
    }

    fn ue(&mut self) -> u32 {
        let mut zeros = 0;
        while self.bit() == 0 {
            zeros += 1;
        }
        let mut value = 0;
        for _ in 0..zeros {
            value = (value << 1) | self.bit();
        }
        (1 << zeros) - 1 + value
    }
}

/// `(profile_idc, chroma_format_idc)` from an SPS NAL unit. 1 is 4:2:0.
pub fn sps_profile_and_chroma(sps: &[u8]) -> (u8, u32) {
    let profile = sps[1];
    let mut bits = Bits::new(&sps[4..]);
    let _sps_id = bits.ue();
    let high = matches!(
        profile,
        100 | 110 | 122 | 244 | 44 | 83 | 86 | 118 | 128 | 138 | 139 | 134 | 135
    );
    (profile, if high { bits.ue() } else { 1 })
}

/// The slice type of a coded slice NAL unit: 0 P, 1 B, 2 I, 3 SP, 4 SI.
pub fn slice_type(slice: &[u8]) -> u32 {
    let mut bits = Bits::new(&slice[1..]);
    let _first_mb = bits.ue();
    bits.ue() % 5
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_high_profile_420_sps_and_an_idr_slice() {
        // x264 SPS (High, level 3.0, 4:2:0) and the start of an I slice.
        let unit = [
            0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1e, 0xac, 0xd9, 0, 0, 1, 0x65, 0x88, 0x84,
        ];
        let nals = nal_units(&unit);
        assert_eq!(nals.len(), 2);
        assert_eq!(nal_type(nals[0]), 7);
        assert_eq!(sps_profile_and_chroma(nals[0]), (100, 1));
        assert_eq!(nal_type(nals[1]), 5);
        assert_eq!(slice_type(nals[1]), 2);
    }
}
