import { useState, useEffect } from 'react';
import type { Equipment, Rates } from '../types';
import { calculateRates } from '../utils/calculations';

export const useEquipmentManager = () => {
  /* 
    Initialize with default state to prevent hydration mismatch.
    The real state will be loaded in a useEffect on the client.
  */
  const [equipment, setEquipment] = useState<Equipment[]>([
    { 
      id: '1', 
      name: 'Dropside', 
      rates: calculateRates(5200), 
      idleDays: [] 
    } 
  ]);

  // Load from localStorage on mount (Client-side only)
  useEffect(() => {
    const saved = localStorage.getItem('plant-hire-data');
    if (saved) {
      try {
        const parsed = JSON.parse(saved, (key, value) => {
          // Revive date strings to Date objects
          if (key === 'idleDays' && Array.isArray(value)) {
            return value.map(d => new Date(d));
          }
          return value;
        });
        setEquipment(parsed);
      } catch (e) {
        console.error('Failed to parse saved data', e);
      }
    }
  }, []);

  // Save to localStorage whenever equipment changes
  useEffect(() => {
    localStorage.setItem('plant-hire-data', JSON.stringify(equipment));
  }, [equipment]);

  const addEquipment = (name: string, rate: string) => {
    if (!name || !rate) return;

    const baseRate = parseFloat(rate);
    const newItem: Equipment = {
      id: Date.now().toString(),
      name,
      rates: calculateRates(baseRate),
      idleDays: [],
    };

    setEquipment([...equipment, newItem]);
  };

  const removeEquipment = (id: string) => {
    setEquipment(equipment.filter((item) => item.id !== id));
  };

  const updateIdleDays = (id: string, days: Date[]) => {
    setEquipment(
      equipment.map((item) =>
        item.id === id ? { ...item, idleDays: days } : item
      )
    );
  };

  const updateRates = (id: string, newRates: Rates) => {
    setEquipment(
      equipment.map((item) => 
        item.id === id ? { ...item, rates: newRates } : item
      )
    );
  };

  return {
    equipment,
    addEquipment,
    removeEquipment,
    updateIdleDays,
    updateRates,
  };
};
