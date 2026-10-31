import { useCallback, useEffect, useRef, useState } from 'react';

export interface Position {
  lat: number;
  lng: number;
  accuracyM?: number;
}

/** One-shot (or watched) browser geolocation. Never prompts until `request()` or `watch` is true. */
export function useGeolocation(watch: boolean) {
  const [position, setPosition] = useState<Position | null>(null);
  const [error, setError] = useState<string | null>(null);
  const watchId = useRef<number | null>(null);

  const onPos = (p: GeolocationPosition) => {
    setError(null);
    setPosition({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy });
  };
  const onErr = (e: GeolocationPositionError) => setError(e.code === e.PERMISSION_DENIED ? 'Location permission denied' : 'Location unavailable');

  const request = useCallback(() => {
    if (!('geolocation' in navigator)) return setError('Location unavailable');
    navigator.geolocation.getCurrentPosition(onPos, onErr, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 });
  }, []);

  useEffect(() => {
    if (!watch || !('geolocation' in navigator)) return;
    watchId.current = navigator.geolocation.watchPosition(onPos, onErr, { enableHighAccuracy: true, maximumAge: 15_000 });
    return () => {
      if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
    };
  }, [watch]);

  return { position, error, request };
}
