package geodat

import (
	"errors"
	"fmt"
	"net/netip"
	"strings"
)

type Country struct {
	Code     string
	Prefixes []netip.Prefix
	Reverse  bool
}

type Domain struct {
	Kind  string
	Value string
}

type Site struct {
	Code    string
	Domains []Domain
}

var domainKind = []string{"plain", "regex", "domain", "full"}

func ParseGeoIP(data []byte) ([]Country, error) {
	fields, err := parseFields(data)
	if err != nil {
		return nil, err
	}
	var out []Country
	for _, field := range fields {
		if field.num != 1 || field.wire != 2 {
			continue
		}
		inner, err := parseFields(field.raw)
		if err != nil {
			return nil, err
		}
		country := Country{}
		for _, item := range inner {
			switch {
			case item.num == 1 && item.wire == 2:
				country.Code = string(item.raw)
			case item.num == 2 && item.wire == 2:
				prefix, ok := prefixFromCIDR(item.raw)
				if ok {
					country.Prefixes = append(country.Prefixes, prefix)
				}
			case item.num == 3 && item.wire == 0:
				country.Reverse = item.varint != 0
			}
		}
		out = append(out, country)
	}
	return out, nil
}

func prefixFromCIDR(raw []byte) (netip.Prefix, bool) {
	fields, err := parseFields(raw)
	if err != nil {
		return netip.Prefix{}, false
	}
	var ip []byte
	var bits int
	sawBits := false
	for _, field := range fields {
		if field.num == 1 && field.wire == 2 {
			ip = field.raw
		}
		if field.num == 2 && field.wire == 0 {
			bits = int(field.varint)
			sawBits = true
		}
	}
	if len(ip) != 4 && len(ip) != 16 {
		return netip.Prefix{}, false
	}
	if !sawBits {
		bits = len(ip) * 8
	}
	addr, ok := netip.AddrFromSlice(ip)
	if !ok || bits < 0 || bits > addr.BitLen() {
		return netip.Prefix{}, false
	}
	return netip.PrefixFrom(addr, bits).Masked(), true
}

func ParseGeoSite(data []byte) ([]Site, error) {
	fields, err := parseFields(data)
	if err != nil {
		return nil, err
	}
	var out []Site
	for _, field := range fields {
		if field.num != 1 || field.wire != 2 {
			continue
		}
		inner, err := parseFields(field.raw)
		if err != nil {
			return nil, err
		}
		site := Site{}
		for _, item := range inner {
			switch {
			case item.num == 1 && item.wire == 2:
				site.Code = string(item.raw)
			case item.num == 2 && item.wire == 2:
				domain, ok := domainFrom(item.raw)
				if ok {
					site.Domains = append(site.Domains, domain)
				}
			}
		}
		out = append(out, site)
	}
	return out, nil
}

func domainFrom(raw []byte) (Domain, bool) {
	fields, err := parseFields(raw)
	if err != nil {
		return Domain{}, false
	}
	domain := Domain{Kind: "plain"}
	for _, field := range fields {
		if field.num == 1 && field.wire == 0 && int(field.varint) < len(domainKind) {
			domain.Kind = domainKind[field.varint]
		}
		if field.num == 2 && field.wire == 2 {
			domain.Value = string(field.raw)
		}
	}
	if domain.Value == "" {
		return Domain{}, false
	}
	return domain, true
}

// PrefixesFor returns the CIDRs for the named countries. Reverse-match
// entries are refused so a country code cannot exclude the rest of the internet.
// An unknown code is an error. An empty request returns no prefixes.
func PrefixesFor(entries []Country, codes []string) ([]netip.Prefix, error) {
	want := map[string]struct{}{}
	for _, code := range codes {
		code = strings.ToUpper(strings.TrimSpace(code))
		if code == "" {
			continue
		}
		want[code] = struct{}{}
	}
	if len(want) == 0 {
		return nil, nil
	}
	found := map[string]struct{}{}
	var out []netip.Prefix
	for _, entry := range entries {
		code := strings.ToUpper(entry.Code)
		if _, ok := want[code]; !ok {
			continue
		}
		if entry.Reverse {
			return nil, fmt.Errorf("geoip %s is reverse-match and cannot be excluded", code)
		}
		found[code] = struct{}{}
		out = append(out, entry.Prefixes...)
	}
	for code := range want {
		if _, ok := found[code]; !ok {
			return nil, fmt.Errorf("geoip has no entry for %s", code)
		}
	}
	return out, nil
}

type field struct {
	num    int
	wire   int
	varint uint64
	raw    []byte
}

func parseFields(data []byte) ([]field, error) {
	var out []field
	for len(data) > 0 {
		tag, n, err := readVarint(data)
		if err != nil {
			return nil, err
		}
		data = data[n:]
		num := int(tag >> 3)
		wire := int(tag & 7)
		if num == 0 {
			return nil, errors.New("protobuf field number is missing")
		}
		switch wire {
		case 0:
			value, m, err := readVarint(data)
			if err != nil {
				return nil, err
			}
			data = data[m:]
			out = append(out, field{num: num, wire: wire, varint: value})
		case 2:
			length, m, err := readVarint(data)
			if err != nil {
				return nil, err
			}
			data = data[m:]
			if uint64(len(data)) < length {
				return nil, errors.New("truncated protobuf bytes")
			}
			out = append(out, field{num: num, wire: wire, raw: data[:length]})
			data = data[length:]
		case 5:
			if len(data) < 4 {
				return nil, errors.New("truncated protobuf fixed32")
			}
			data = data[4:]
		case 1:
			if len(data) < 8 {
				return nil, errors.New("truncated protobuf fixed64")
			}
			data = data[8:]
		default:
			return nil, errors.New("unsupported protobuf wire type")
		}
	}
	return out, nil
}

func readVarint(data []byte) (uint64, int, error) {
	var value uint64
	for i, b := range data {
		if i > 9 {
			return 0, 0, errors.New("protobuf varint is too long")
		}
		value |= uint64(b&0x7f) << (7 * i)
		if b&0x80 == 0 {
			return value, i + 1, nil
		}
	}
	return 0, 0, errors.New("truncated protobuf varint")
}
