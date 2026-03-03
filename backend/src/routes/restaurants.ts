import { Router } from 'express';
import { searchRestaurants as searchResy } from '../api/resy-client.js';
import type { ApiResponse, SearchResult } from '../../../shared/src/types.js';

const router = Router();

// Search restaurants on Resy
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
    
    // Query Resy
    const resyResults = await searchResy(query as string, location as string);
    
    const combinedResults: SearchResult = {
      restaurants: resyResults.restaurants,
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
