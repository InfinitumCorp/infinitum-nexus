package geodat

import (
	"net/netip"
	"testing"
)

func TestSyntheticGeoIPAndDisabledCapture(t *testing.T) {
	data := geoipList(
		geoip("ZZ", []cidr{{ip: []byte{203, 0, 113, 0}, bits: 24}}, false),
		geoip("QQ", []cidr{{ip: []byte{198, 51, 100, 8}, bits: 32}}, true),
	)
	entries, err := ParseGeoIP(data)
	if err != nil {
		t.Fatal(err)
	}
	prefixes, err := PrefixesFor(entries, []string{"zz"})
	if err != nil {
		t.Fatal(err)
	}
	if len(prefixes) != 1 || prefixes[0].String() != "203.0.113.0/24" {
		t.Fatalf("prefixes = %v", prefixes)
	}
	if _, err := PrefixesFor(entries, []string{"QQ"}); err == nil {
		t.Fatal("reverse-match country was accepted")
	}
	if _, err := PrefixesFor(entries, []string{"US"}); err == nil {
		t.Fatal("missing country was accepted")
	}
	inside, direct := Capture(false, prefixes)
	if len(direct) != 0 || inside[0].String() != "0.0.0.0/0" || inside[1].String() != "::/0" {
		t.Fatalf("disabled capture = %v direct %v", inside, direct)
	}
	inside, direct = Capture(true, prefixes)
	if !ContainsIP(direct, netip.MustParseAddr("203.0.113.9")) {
		t.Fatal("excluded address was not listed as direct")
	}
	if ContainsIP(inside, netip.MustParseAddr("203.0.113.9")) {
		t.Fatal("excluded address stayed inside the tunnel")
	}
	if !ContainsIP(inside, netip.MustParseAddr("8.8.8.8")) || !ContainsIP(inside, netip.MustParseAddr("2001:db8::1")) {
		t.Fatal("unrelated addresses left the tunnel")
	}
}

func TestSyntheticGeoSiteSkipsKeywords(t *testing.T) {
	data := geositeList(
		geosite("category-ads", []domain{{kind: 2, value: "tracker.example"}, {kind: 0, value: "ads"}}),
	)
	sites, err := ParseGeoSite(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(sites) != 1 || sites[0].Domains[0].Kind != "domain" || sites[0].Domains[1].Kind != "plain" {
		t.Fatalf("sites = %+v", sites)
	}
}

type cidr struct {
	ip   []byte
	bits int
}

type domain struct {
	kind  int
	value string
}

func geoipList(entries ...[]byte) []byte   { return concat(entries...) }
func geositeList(entries ...[]byte) []byte { return concat(entries...) }

func geoip(code string, ranges []cidr, reverse bool) []byte {
	parts := [][]byte{bytesField(1, []byte(code))}
	for _, item := range ranges {
		parts = append(parts, bytesField(2, concat(bytesField(1, item.ip), varintField(2, uint64(item.bits)))))
	}
	if reverse {
		parts = append(parts, varintField(3, 1))
	}
	return bytesField(1, concat(parts...))
}

func geosite(code string, domains []domain) []byte {
	parts := [][]byte{bytesField(1, []byte(code))}
	for _, item := range domains {
		body := concat(varintField(1, uint64(item.kind)), bytesField(2, []byte(item.value)))
		parts = append(parts, bytesField(2, body))
	}
	return bytesField(1, concat(parts...))
}

func bytesField(field int, payload []byte) []byte {
	return concat(key(field, 2), varint(uint64(len(payload))), payload)
}

func varintField(field int, value uint64) []byte {
	return concat(key(field, 0), varint(value))
}

func key(field, wire int) []byte { return varint(uint64(field<<3 | wire)) }

func varint(value uint64) []byte {
	var out []byte
	for value > 127 {
		out = append(out, byte(value)|0x80)
		value >>= 7
	}
	return append(out, byte(value))
}

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}
