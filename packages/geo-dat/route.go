package geodat

import "net/netip"

// FullCapture is the default device route: every IPv4 and IPv6 address.
func FullCapture() []netip.Prefix {
	return []netip.Prefix{netip.MustParsePrefix("0.0.0.0/0"), netip.MustParsePrefix("::/0")}
}

// Capture returns the prefixes that stay inside the tunnel and the prefixes
// that may leave outside it. A disabled switch ignores the exclusion list and
// returns a full tunnel with no direct prefixes.
func Capture(enabled bool, excluded []netip.Prefix) (inside, direct []netip.Prefix) {
	full := FullCapture()
	if !enabled || len(excluded) == 0 {
		return full, nil
	}
	v4 := []netip.Prefix{full[0]}
	v6 := []netip.Prefix{full[1]}
	for _, hole := range excluded {
		if !hole.IsValid() {
			continue
		}
		hole = hole.Masked()
		direct = append(direct, hole)
		if hole.Addr().Is4() {
			v4 = subtractAll(v4, hole)
		} else {
			v6 = subtractAll(v6, hole)
		}
	}
	if len(direct) == 0 {
		return full, nil
	}
	return append(v4, v6...), direct
}

func subtractAll(prefixes []netip.Prefix, hole netip.Prefix) []netip.Prefix {
	var out []netip.Prefix
	for _, prefix := range prefixes {
		out = append(out, subtract(prefix, hole)...)
	}
	return out
}

func subtract(base, cut netip.Prefix) []netip.Prefix {
	base = base.Masked()
	cut = cut.Masked()
	if !base.IsValid() || !cut.IsValid() || base.Addr().BitLen() != cut.Addr().BitLen() {
		return []netip.Prefix{base}
	}
	if !base.Overlaps(cut) {
		return []netip.Prefix{base}
	}
	if cut.Bits() <= base.Bits() {
		return nil
	}
	var out []netip.Prefix
	cur := base
	for cur.Bits() < cut.Bits() {
		left, right := halves(cur)
		if left.Overlaps(cut) {
			out = append(out, right)
			cur = left
		} else {
			out = append(out, left)
			cur = right
		}
	}
	return out
}

func halves(prefix netip.Prefix) (netip.Prefix, netip.Prefix) {
	bits := prefix.Bits() + 1
	addr := prefix.Masked().Addr()
	left := netip.PrefixFrom(addr, bits).Masked()
	var rightAddr netip.Addr
	index := (bits - 1) / 8
	bit := uint(7 - ((bits - 1) % 8))
	if addr.Is4() {
		raw := addr.As4()
		raw[index] |= 1 << bit
		rightAddr = netip.AddrFrom4(raw)
	} else {
		raw := addr.As16()
		raw[index] |= 1 << bit
		rightAddr = netip.AddrFrom16(raw)
	}
	return left, netip.PrefixFrom(rightAddr, bits).Masked()
}

// ContainsIP reports whether ip is inside any prefix.
func ContainsIP(prefixes []netip.Prefix, ip netip.Addr) bool {
	for _, prefix := range prefixes {
		if prefix.Contains(ip) {
			return true
		}
	}
	return false
}
