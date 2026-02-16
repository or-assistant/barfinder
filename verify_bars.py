#!/usr/bin/env python3
"""
Bar Verification Script for Hamburg Barfinder
Systematically verifies all 204 bars against multiple sources.
"""

import json
import time
import requests
import urllib.parse
from typing import List, Dict, Any
import logging

# Set up logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

class BarVerifier:
    def __init__(self, highlights_path: str):
        self.highlights_path = highlights_path
        self.verification_report = []
        self.processed_count = 0
        self.session = requests.Session()
        self.session.headers.update({'User-Agent': 'BarFinder/1.0 (Hamburg Barfinder Verification)'})
        
    def load_bars(self) -> List[Dict[Any, Any]]:
        """Load bars from highlights.json"""
        with open(self.highlights_path, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def save_report(self):
        """Save verification report to JSON"""
        report_path = '/home/openclaw/.openclaw/workspace/barfinder/verification_report.json'
        with open(report_path, 'w', encoding='utf-8') as f:
            json.dump(self.verification_report, f, indent=2, ensure_ascii=False)
        logger.info(f"Report saved to {report_path}")
    
    def verify_osm_nominatim(self, bar_name: str, address: str = "") -> Dict[str, Any]:
        """Verify bar exists in OpenStreetMap via Nominatim"""
        try:
            # Try with name + Hamburg first
            query = f"{bar_name} Hamburg"
            url = f"https://nominatim.openstreetmap.org/search?q={urllib.parse.quote(query)}&format=json&limit=3"
            
            logger.info(f"Checking OSM: {query}")
            response = self.session.get(url, timeout=10)
            
            if response.status_code == 200:
                results = response.json()
                if results:
                    # Check if any result seems like a bar/restaurant
                    for result in results:
                        if any(term in result.get('type', '').lower() for term in ['bar', 'pub', 'restaurant', 'cafe']):
                            return {
                                'found': True,
                                'source': 'osm',
                                'match': result,
                                'confidence': 'high'
                            }
                    # If we found results but none are clearly bars, mark as low confidence
                    return {
                        'found': True,
                        'source': 'osm',
                        'match': results[0],
                        'confidence': 'low'
                    }
                else:
                    return {'found': False, 'source': 'osm', 'error': None}
            else:
                return {'found': False, 'source': 'osm', 'error': f"HTTP {response.status_code}"}
                
        except Exception as e:
            logger.error(f"OSM verification failed for {bar_name}: {e}")
            return {'found': False, 'source': 'osm', 'error': str(e)}
    
    def verify_google_maps(self, bar_name: str) -> Dict[str, Any]:
        """Verify bar via Google Maps through smry.ai proxy"""
        try:
            # URL encode the search query
            search_query = urllib.parse.quote(f"{bar_name} Hamburg")
            google_url = f"https://www.google.com/maps/search/{search_query}"
            proxy_url = f"https://smry.ai/proxy?url={urllib.parse.quote(google_url)}"
            
            logger.info(f"Checking Google Maps: {bar_name}")
            response = self.session.get(proxy_url, timeout=15)
            
            if response.status_code == 200:
                content = response.text.lower()
                # Look for indicators that we found the place
                if any(indicator in content for indicator in [
                    'restaurant', 'bar', 'pub', 'kneipe', 'café', 'cafe',
                    'opening hours', 'öffnungszeiten', 'phone', 'telefon',
                    'address', 'adresse', 'reviews', 'bewertungen'
                ]):
                    return {'found': True, 'source': 'google', 'confidence': 'medium'}
                else:
                    return {'found': False, 'source': 'google', 'error': 'No clear match found'}
            else:
                return {'found': False, 'source': 'google', 'error': f"HTTP {response.status_code}"}
                
        except Exception as e:
            logger.error(f"Google Maps verification failed for {bar_name}: {e}")
            return {'found': False, 'source': 'google', 'error': str(e)}
    
    def verify_website(self, website_url: str) -> Dict[str, Any]:
        """Verify bar by checking its website"""
        if not website_url:
            return {'found': False, 'source': 'website', 'error': 'No website provided'}
        
        try:
            logger.info(f"Checking website: {website_url}")
            response = self.session.get(website_url, timeout=10)
            
            if response.status_code == 200:
                return {'found': True, 'source': 'website', 'confidence': 'high'}
            elif response.status_code in [301, 302, 303, 307, 308]:
                return {'found': True, 'source': 'website', 'confidence': 'medium', 'note': 'Redirected'}
            else:
                return {'found': False, 'source': 'website', 'error': f"HTTP {response.status_code}"}
                
        except Exception as e:
            logger.error(f"Website verification failed for {website_url}: {e}")
            return {'found': False, 'source': 'website', 'error': str(e)}
    
    def verify_bar(self, bar: Dict[str, Any]) -> Dict[str, Any]:
        """Verify a single bar through the verification hierarchy"""
        name = bar['name']
        address = bar.get('address', '')
        website = bar.get('website', '')
        
        result = {
            'name': name,
            'address': address,
            'website': website,
            'status': 'not_found',
            'source': 'none',
            'notes': '',
            'verification_attempts': []
        }
        
        logger.info(f"Verifying: {name}")
        
        # Step 1: Check Nominatim/OSM
        osm_result = self.verify_osm_nominatim(name, address)
        result['verification_attempts'].append(osm_result)
        
        if osm_result['found'] and osm_result.get('confidence') == 'high':
            result['status'] = 'verified'
            result['source'] = 'osm'
            result['notes'] = 'Found in OpenStreetMap with high confidence'
            return result
        
        # Respect 1 req/sec rate limit for Nominatim
        time.sleep(1.1)
        
        # Step 2: If not found in OSM or low confidence, try Google
        google_result = self.verify_google_maps(name)
        result['verification_attempts'].append(google_result)
        
        if google_result['found']:
            result['status'] = 'verified'
            result['source'] = 'google'
            result['notes'] = 'Found via Google Maps'
            return result
        
        # Step 3: If still not found, try website if available
        if website:
            website_result = self.verify_website(website)
            result['verification_attempts'].append(website_result)
            
            if website_result['found']:
                result['status'] = 'verified'
                result['source'] = 'website'
                result['notes'] = 'Website is accessible'
                return result
        
        # Step 4: If still not verifiable, flag as suspicious
        if osm_result['found'] and osm_result.get('confidence') == 'low':
            result['status'] = 'suspicious'
            result['source'] = 'osm'
            result['notes'] = 'Found in OSM but not clearly identified as bar/restaurant'
        else:
            result['status'] = 'not_found'
            result['notes'] = 'Could not verify existence through any source'
        
        return result
    
    def find_duplicates(self, bars: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Find potential duplicates based on similar names and addresses"""
        duplicates = []
        
        for i, bar1 in enumerate(bars):
            for j, bar2 in enumerate(bars[i+1:], i+1):
                name1 = bar1['name'].lower().strip()
                name2 = bar2['name'].lower().strip()
                addr1 = bar1.get('address', '').lower().strip()
                addr2 = bar2.get('address', '').lower().strip()
                
                # Check for similar names (allow for minor differences)
                name_similar = (
                    name1 == name2 or 
                    name1 in name2 or 
                    name2 in name1 or
                    self.levenshtein_distance(name1, name2) <= 2
                )
                
                # Check for same address
                addr_same = addr1 and addr2 and addr1 == addr2
                
                if name_similar or addr_same:
                    duplicates.append({
                        'bar1': bar1,
                        'bar2': bar2,
                        'similarity_reason': 'name' if name_similar else 'address'
                    })
        
        return duplicates
    
    def levenshtein_distance(self, s1: str, s2: str) -> int:
        """Calculate Levenshtein distance between two strings"""
        if len(s1) < len(s2):
            return self.levenshtein_distance(s2, s1)
        
        if len(s2) == 0:
            return len(s1)
        
        previous_row = list(range(len(s2) + 1))
        for i, c1 in enumerate(s1):
            current_row = [i + 1]
            for j, c2 in enumerate(s2):
                insertions = previous_row[j + 1] + 1
                deletions = current_row[j] + 1
                substitutions = previous_row[j] + (c1 != c2)
                current_row.append(min(insertions, deletions, substitutions))
            previous_row = current_row
        
        return previous_row[-1]
    
    def run_verification(self):
        """Run the complete verification process"""
        logger.info("Starting bar verification process...")
        
        # Load bars
        bars = self.load_bars()
        total_bars = len(bars)
        logger.info(f"Loaded {total_bars} bars to verify")
        
        # Find duplicates first
        logger.info("Checking for duplicates...")
        duplicates = self.find_duplicates(bars)
        if duplicates:
            logger.info(f"Found {len(duplicates)} potential duplicates")
        
        # Verify each bar
        suspicious_bars = []
        not_found_bars = []
        verified_count = 0
        
        for i, bar in enumerate(bars):
            try:
                result = self.verify_bar(bar)
                self.verification_report.append(result)
                
                if result['status'] == 'verified':
                    verified_count += 1
                elif result['status'] == 'suspicious':
                    suspicious_bars.append(result)
                elif result['status'] == 'not_found':
                    not_found_bars.append(result)
                
                self.processed_count += 1
                
                # Progress update
                if (i + 1) % 10 == 0:
                    logger.info(f"Progress: {i+1}/{total_bars} bars processed")
                    self.save_report()  # Save intermediate progress
                
                # Small delay to be respectful to APIs
                time.sleep(0.5)
                
            except Exception as e:
                logger.error(f"Failed to verify {bar['name']}: {e}")
                self.verification_report.append({
                    'name': bar['name'],
                    'status': 'error',
                    'notes': f"Verification failed: {str(e)}"
                })
        
        # Save final report
        self.save_report()
        
        # Print summary
        logger.info(f"\n=== VERIFICATION SUMMARY ===")
        logger.info(f"Total bars processed: {total_bars}")
        logger.info(f"Verified: {verified_count}")
        logger.info(f"Suspicious: {len(suspicious_bars)}")
        logger.info(f"Not found: {len(not_found_bars)}")
        logger.info(f"Potential duplicates: {len(duplicates)}")
        
        if suspicious_bars or not_found_bars:
            logger.info(f"\n=== BARS NEEDING ATTENTION ===")
            for bar in suspicious_bars + not_found_bars:
                logger.info(f"- {bar['name']} ({bar['status']}): {bar['notes']}")
        
        return {
            'total': total_bars,
            'verified': verified_count,
            'suspicious': suspicious_bars,
            'not_found': not_found_bars,
            'duplicates': duplicates
        }

if __name__ == "__main__":
    verifier = BarVerifier('/home/openclaw/.openclaw/workspace/barfinder/highlights.json')
    results = verifier.run_verification()