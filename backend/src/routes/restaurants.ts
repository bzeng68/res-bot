import { Router } from 'express';
import { searchRestaurants as searchResy } from '../api/resy-client.js';
import { searchRestaurants as searchOpenTable } from '../api/opentable-client.js';
import type { ApiResponse, SearchResult } from '../../../shared/src/types.js';

const router = Router();

// Search restaurants across both Resy and OpenTable
router.get('/search', async (req, res) => {
  try {
    const { query, location } = req.query;
    
    if (!query || !location) {
      res.status(400).json({ 
        success: false, 
        error: 'Query and location are required' 
      } as ApiResponse<never>);
      return;
    }
    
    // Query both platforms in parallel
    const [resyResults, openTableResults] = await Promise.allSettled([
      searchResy(query as string, location as string),
      searchOpenTable(query as string, location as string),
    ]);
    
    // Combine results from both platforms
    const restaurants = [
      ...(resyResults.status === 'fulfilled' ? resyResults.value.restaurants : []),
      ...(openTableResults.status === 'fulfilled' ? openTableResults.value.restaurants : []),
    ];
    
    const combinedResults: SearchResult = {
      restaurants,
      query: query as string,
    };
    
    res.json({ 
      success: true, 
      data: combinedResults 
    } as ApiResponse<SearchResult>);
  } catch (error) {
    console.error('Error searching restaurants:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to search restaurants' 
    } as ApiResponse<never>);
  }
});

export default router;
