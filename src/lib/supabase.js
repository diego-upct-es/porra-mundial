import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Faltan variables de entorno.\n' +
    'Copia .env.example como .env.local y rellena VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.\n' +
    'Encuéntralas en Supabase Dashboard → Project Settings → API.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
