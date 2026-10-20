import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Switch,
  ScrollView,
  StyleSheet,
  Modal,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Camera,
  CameraSettings,
  CameraSettingsChange,
  DayNightMode,
  ProfileSlot,
  activeProfileSlot,
} from '../utils/storage';
import { FRAMESIZE_MODES, SETTING_DEFS, SettingDef, WB_MODES } from '../utils/cameraSettings';
import { requestInstallLocation } from '../utils/deviceLocation';
import { Country, findCountries } from '../data/countries';
import { resolveNightWindow, valid } from '../utils/sunWindow';

interface Props {
  camera: Camera | null;
  onClose: () => void;
  onChange: (cameraId: string, change: CameraSettingsChange) => void;
  onSetMode: (cameraId: string, mode: DayNightMode) => void;
  /** Global install location (store-level); absent until one is set. */
  location?: { lat: number; lng: number };
  /**
   * Persist the install location through the app's existing store save path.
   * `undefined` clears it. Optional so the sheet still renders standalone.
   */
  onSetLocation?: (location: { lat: number; lng: number } | undefined) => void;
}

const MODES: { value: DayNightMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'day', label: 'Day' },
  { value: 'night', label: 'Night' },
];

/** How many country rows a search shows at once. */
const MAX_COUNTRY_MATCHES = 6;

/** Parse a user-entered coordinate; null when blank or not a finite number. */
function parseCoord(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text.trim());
  return Number.isFinite(value) ? value : null;
}

/** Round to ~11 m and drop trailing noise so the field reads cleanly. */
function formatCoord(value: number): string {
  return String(Math.round(value * 10000) / 10000);
}

/** Local "HH:MM" for a solar instant. */
function formatClock(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * "Tonight's dusk HH:MM · Tomorrow's dawn HH:MM" for the entered coordinates.
 * Dusk comes from today's solar day; dawn from the next day's, so the pair
 * reads as the coming night.
 */
function formatReadout(lat: number, lng: number): string {
  const now = new Date();
  const today = resolveNightWindow(now, lat, lng);
  if (today.alwaysUp) return 'The sun stays up here today.';
  if (today.alwaysDown) return 'The sun stays down here today.';
  const tomorrow = resolveNightWindow(new Date(now.getTime() + 24 * 60 * 60 * 1000), lat, lng);
  const dusk = valid(today.dusk) ? formatClock(today.dusk) : null;
  const dawn = valid(tomorrow.dawn) ? formatClock(tomorrow.dawn) : null;
  const duskPart = dusk ? `Tonight's dusk ${dusk}` : 'No dusk today';
  const dawnPart = dawn ? `Tomorrow's dawn ${dawn}` : 'no dawn tomorrow';
  return `${duskPart} · ${dawnPart}`;
}

function slotForNow(camera: Camera): ProfileSlot {
  // Initial tab only; the solar window is supplied elsewhere (App/hook), so the
  // shared fallback rule (null window) is used here.
  return activeProfileSlot(camera, new Date(), null);
}

export default function CameraSettingsSheet({
  camera,
  onClose,
  onChange,
  onSetMode,
  location,
  onSetLocation,
}: Props) {
  const insets = useSafeAreaInsets();
  const [slot, setSlot] = useState<ProfileSlot>('day');

  // Location fields are held as text so they stay editable/validated; they are
  // committed (persisted) only once both parse to an in-range pair.
  const [latText, setLatText] = useState('');
  const [lngText, setLngText] = useState('');
  const [countryQuery, setCountryQuery] = useState('');
  const [locating, setLocating] = useState(false);
  const [locationNote, setLocationNote] = useState<string | null>(null);

  // When a different camera is opened, start on whichever profile is active now.
  useEffect(() => {
    if (camera) setSlot(slotForNow(camera));
  }, [camera?.id]);

  // Reflect the persisted location into the fields when it changes.
  useEffect(() => {
    if (location) {
      setLatText(formatCoord(location.lat));
      setLngText(formatCoord(location.lng));
    }
  }, [location?.lat, location?.lng]);

  const profile: CameraSettings | null = camera
    ? slot === 'day' ? camera.day : camera.night
    : null;

  function patch(key: keyof CameraSettings, value: number | boolean) {
    if (!camera) return;
    onChange(camera.id, { kind: 'patch', slot, patch: { [key]: value } as Partial<CameraSettings> });
  }

  function step(def: SettingDef, dir: 1 | -1) {
    if (!camera || !profile) return;
    const min = def.min ?? 0;
    const max = def.max ?? 0;
    const stepSize = def.step ?? 1;
    const current = profile[def.key] as number;
    const next = Math.min(max, Math.max(min, current + dir * stepSize));
    if (next !== current) patch(def.key, next);
  }

  function copyToOther() {
    if (!camera) return;
    const to: ProfileSlot = slot === 'day' ? 'night' : 'day';
    onChange(camera.id, { kind: 'copy', from: slot, to });
    setSlot(to);
  }

  // --- Location -----------------------------------------------------------

  const parsedLat = parseCoord(latText);
  const parsedLng = parseCoord(lngText);
  const latOutOfRange = parsedLat !== null && (parsedLat < -90 || parsedLat > 90);
  const lngOutOfRange = parsedLng !== null && (parsedLng < -180 || parsedLng > 180);
  const latBad = latText.trim() !== '' && parsedLat === null;
  const lngBad = lngText.trim() !== '' && parsedLng === null;

  const countryMatches = countryQuery.trim()
    ? findCountries(countryQuery).slice(0, MAX_COUNTRY_MATCHES)
    : [];

  const readout =
    parsedLat === null || parsedLng === null
      ? 'Enter coordinates to see dawn and dusk.'
      : latOutOfRange || lngOutOfRange
        ? 'Coordinates are out of range.'
        : formatReadout(parsedLat, parsedLng);

  /** Persist the pair only when both fields parse to in-range values. */
  function commitCoords() {
    if (parsedLat === null || parsedLng === null) return;
    if (latOutOfRange || lngOutOfRange) return;
    onSetLocation?.({ lat: parsedLat, lng: parsedLng });
  }

  function applyCoords(lat: number, lng: number) {
    setLatText(formatCoord(lat));
    setLngText(formatCoord(lng));
    setLocationNote(null);
    onSetLocation?.({ lat, lng });
  }

  async function useMyLocation() {
    if (locating) return;
    setLocating(true);
    setLocationNote(null);
    const coords = await requestInstallLocation();
    setLocating(false);
    if (!coords) {
      setLocationNote('Location unavailable. Enter coordinates or pick a country.');
      return;
    }
    applyCoords(coords.lat, coords.lng);
  }

  function pickCountry(country: Country) {
    setCountryQuery('');
    applyCoords(country.lat, country.lng);
  }

  return (
    <Modal
      visible={camera !== null}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { paddingBottom: 24 + insets.bottom }]}>
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.title}>Camera settings</Text>
              {camera && <Text style={styles.subtitle} numberOfLines={1}>{camera.name}</Text>}
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.close}>Done</Text>
            </TouchableOpacity>
          </View>

          {camera && (
            <View style={styles.controls}>
              {/* Schedule mode: Auto · Day · Night */}
              <View style={styles.modeRow}>
                <Text style={styles.modeLabel}>Mode</Text>
                <View style={styles.segment}>
                  {MODES.map(m => {
                    const selected = camera.dayNight === m.value;
                    return (
                      <TouchableOpacity
                        key={m.value}
                        style={[styles.segmentItem, selected && styles.segmentItemActive]}
                        onPress={() => onSetMode(camera.id, m.value)}
                      >
                        <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>
                          {m.label}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              {/* Editable profile tabs */}
              <View style={styles.tabRow}>
                {(['day', 'night'] as ProfileSlot[]).map(s => {
                  const selected = slot === s;
                  return (
                    <TouchableOpacity
                      key={s}
                      style={[styles.tab, selected && styles.tabActive]}
                      onPress={() => setSlot(s)}
                    >
                      <Text style={[styles.tabText, selected && styles.tabTextActive]}>
                        {s === 'day' ? 'Day' : 'Night'}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                <TouchableOpacity style={styles.copyBtn} onPress={copyToOther}>
                  <Text style={styles.copyText}>
                    Copy {slot === 'day' ? 'Day → Night' : 'Night → Day'}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          <ScrollView style={styles.bodyScroll} contentContainerStyle={styles.body} removeClippedSubviews={false}>
            {camera && (
              <View style={styles.locationSection}>
                <View style={styles.locationHeader}>
                  <Text style={styles.label}>Location</Text>
                  <TouchableOpacity
                    style={styles.locBtn}
                    onPress={useMyLocation}
                    disabled={locating}
                  >
                    <Text style={styles.locBtnText}>
                      {locating ? 'Locating…' : 'Use my location'}
                    </Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.note}>
                  Sets today's dawn and dusk for auto day/night.
                </Text>

                <View style={styles.coordRow}>
                  <View style={styles.coordField}>
                    <Text style={styles.coordLabel}>Latitude</Text>
                    <TextInput
                      style={styles.coordInput}
                      value={latText}
                      onChangeText={setLatText}
                      onBlur={commitCoords}
                      keyboardType="numbers-and-punctuation"
                      placeholder="0"
                      placeholderTextColor="#444"
                      underlineColorAndroid="transparent"
                    />
                  </View>
                  <View style={styles.coordField}>
                    <Text style={styles.coordLabel}>Longitude</Text>
                    <TextInput
                      style={styles.coordInput}
                      value={lngText}
                      onChangeText={setLngText}
                      onBlur={commitCoords}
                      keyboardType="numbers-and-punctuation"
                      placeholder="0"
                      placeholderTextColor="#444"
                      underlineColorAndroid="transparent"
                    />
                  </View>
                </View>
                {(latBad || lngBad || latOutOfRange || lngOutOfRange) && (
                  <Text style={styles.errorNote}>
                    Enter a latitude -90 to 90 and a longitude -180 to 180.
                  </Text>
                )}

                <Text style={styles.countryLabel}>Country</Text>
                <TextInput
                  style={[styles.coordInput, styles.countryInput]}
                  value={countryQuery}
                  onChangeText={setCountryQuery}
                  placeholder="Search countries"
                  placeholderTextColor="#444"
                  autoCorrect={false}
                  autoCapitalize="none"
                  underlineColorAndroid="transparent"
                />
                <Text style={styles.note}>
                  Starting point for a region — fine-tune the fields above.
                </Text>
                {countryMatches.length > 0 && (
                  <View style={styles.countryList}>
                    {countryMatches.map(c => (
                      <TouchableOpacity
                        key={c.code}
                        style={styles.countryItem}
                        onPress={() => pickCountry(c)}
                      >
                        <Text style={styles.countryName}>{c.name}</Text>
                        <Text style={styles.countryCode}>{c.code}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
                {countryQuery.trim() !== '' && countryMatches.length === 0 && (
                  <Text style={styles.note}>No matching countries.</Text>
                )}

                {locationNote ? <Text style={styles.note}>{locationNote}</Text> : null}

                <Text style={styles.readout}>{readout}</Text>
              </View>
            )}
            {camera && profile && SETTING_DEFS.map(def => {
              const value = profile[def.key];

              if (def.kind === 'toggle') {
                return (
                  <View key={def.key} style={styles.row}>
                    <View style={styles.labelWrap}>
                      <Text style={styles.label}>{def.label}</Text>
                      {def.note ? <Text style={styles.note}>{def.note}</Text> : null}
                    </View>
                    <Switch
                      value={value as boolean}
                      onValueChange={v => patch(def.key, v)}
                      trackColor={{ false: '#333', true: '#e63' }}
                      thumbColor="#fff"
                    />
                  </View>
                );
              }

              if (def.kind === 'wb') {
                return (
                  <View key={def.key} style={styles.block}>
                    <Text style={styles.label}>{def.label}</Text>
                    <View style={styles.segment}>
                      {WB_MODES.map((mode, idx) => {
                        const selected = value === idx;
                        return (
                          <TouchableOpacity
                            key={mode}
                            style={[styles.segmentItem, selected && styles.segmentItemActive]}
                            onPress={() => patch(def.key, idx)}
                          >
                            <Text style={[styles.segmentText, selected && styles.segmentTextActive]}>
                              {mode}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                );
              }

              if (def.kind === 'framesize') {
                return (
                  <View key={def.key} style={styles.block}>
                    <Text style={styles.label}>{def.label}</Text>
                    <View style={styles.fsWrap}>
                      {FRAMESIZE_MODES.map(fs => {
                        const selected = value === fs.value;
                        return (
                          <TouchableOpacity
                            key={fs.value}
                            style={[styles.fsItem, selected && styles.fsItemActive]}
                            onPress={() => patch(def.key, fs.value)}
                          >
                            <Text style={[styles.fsText, selected && styles.fsTextActive]}>
                              {fs.label}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                    {def.note ? <Text style={styles.note}>{def.note}</Text> : null}
                  </View>
                );
              }

              // numeric stepper
              const atMin = (value as number) <= (def.min ?? 0);
              const atMax = (value as number) >= (def.max ?? 0);
              return (
                <View key={def.key} style={styles.row}>
                  <View style={styles.labelWrap}>
                    <Text style={styles.label}>{def.label}</Text>
                    {def.note ? <Text style={styles.note}>{def.note}</Text> : null}
                  </View>
                  <View style={styles.stepper}>
                    <TouchableOpacity
                      style={[styles.stepBtn, atMin && styles.stepBtnDisabled]}
                      disabled={atMin}
                      onPress={() => step(def, -1)}
                    >
                      <Text style={styles.stepBtnText}>−</Text>
                    </TouchableOpacity>
                    <Text style={styles.stepValue}>{String(value)}</Text>
                    <TouchableOpacity
                      style={[styles.stepBtn, atMax && styles.stepBtnDisabled]}
                      disabled={atMax}
                      onPress={() => step(def, 1)}
                    >
                      <Text style={styles.stepBtnText}>+</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              );
            })}

          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop:           { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet:              { backgroundColor: '#111', borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '85%', paddingBottom: 24 },
  header:             { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#222' },
  headerText:         { flex: 1, marginRight: 12 },
  title:              { color: '#fff', fontSize: 17, fontWeight: '700' },
  subtitle:           { color: '#666', fontSize: 12, marginTop: 2 },
  close:              { color: '#e63', fontSize: 15, fontWeight: '600' },
  controls:           { paddingHorizontal: 20, paddingTop: 12 },
  modeRow:            { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  modeLabel:          { color: '#888', fontSize: 12, fontWeight: '600', marginRight: 12 },
  tabRow:             { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 8 },
  tab:                { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a' },
  tabActive:          { backgroundColor: '#e63', borderColor: '#e63' },
  tabText:            { color: '#888', fontSize: 13, fontWeight: '700' },
  tabTextActive:      { color: '#fff' },
  copyBtn:            { marginLeft: 'auto', paddingHorizontal: 10, paddingVertical: 8 },
  copyText:           { color: '#e63', fontSize: 12, fontWeight: '600' },
  bodyScroll:         { flexShrink: 1 },
  body:               { paddingHorizontal: 20, paddingTop: 8 },
  row:                { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1c1c1c' },
  block:              { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1c1c1c' },
  labelWrap:          { flex: 1, marginRight: 12 },
  label:              { color: '#fff', fontSize: 14, fontWeight: '600' },
  note:               { color: '#555', fontSize: 11, marginTop: 2 },
  stepper:            { flexDirection: 'row', alignItems: 'center' },
  stepBtn:            { width: 36, height: 36, borderRadius: 8, backgroundColor: '#222', alignItems: 'center', justifyContent: 'center' },
  stepBtnDisabled:    { opacity: 0.35 },
  stepBtnText:        { color: '#e63', fontSize: 20, fontWeight: '700', lineHeight: 22 },
  stepValue:          { color: '#fff', fontSize: 15, fontWeight: '600', minWidth: 44, textAlign: 'center' },
  segment:            { flex: 1, flexDirection: 'row', backgroundColor: '#1a1a1a', borderRadius: 8, overflow: 'hidden' },
  segmentItem:        { flex: 1, paddingVertical: 10, alignItems: 'center' },
  segmentItemActive:  { backgroundColor: '#e63' },
  segmentText:        { color: '#888', fontSize: 11, fontWeight: '600' },
  segmentTextActive:  { color: '#fff' },
  fsWrap:             { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  fsItem:             { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a' },
  fsItemActive:       { backgroundColor: '#e63', borderColor: '#e63' },
  fsText:             { color: '#888', fontSize: 12, fontWeight: '700' },
  fsTextActive:       { color: '#fff' },
  locationSection:    { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1c1c1c' },
  locationHeader:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  locBtn:             { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a' },
  locBtnText:         { color: '#e63', fontSize: 12, fontWeight: '600' },
  coordRow:           { flexDirection: 'row', gap: 10, marginTop: 10 },
  coordField:         { flex: 1 },
  coordLabel:         { color: '#888', fontSize: 12, fontWeight: '600', marginBottom: 6 },
  countryLabel:       { color: '#888', fontSize: 12, fontWeight: '600', marginTop: 16, marginBottom: 6 },
  coordInput:         { backgroundColor: '#1a1a1a', borderWidth: 1, borderColor: '#2a2a2a', borderRadius: 8, color: '#fff', fontSize: 14, paddingHorizontal: 12, paddingVertical: 10 },
  countryInput:       { marginTop: 0 },
  countryList:        { marginTop: 8, backgroundColor: '#1a1a1a', borderRadius: 8, borderWidth: 1, borderColor: '#2a2a2a', overflow: 'hidden' },
  countryItem:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#222' },
  countryName:        { color: '#fff', fontSize: 13, fontWeight: '600' },
  countryCode:        { color: '#666', fontSize: 12, fontWeight: '600' },
  errorNote:          { color: '#e63', fontSize: 11, marginTop: 6 },
  readout:            { color: '#aaa', fontSize: 12, marginTop: 12 },
});
