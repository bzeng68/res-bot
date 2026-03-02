import { Router } from 'express';
import { requestSmsCode, verifySmsCode } from '../api/resy-client.js';
import type { ApiResponse } from '../../../shared/src/types.js';

const router = Router();

// Request SMS verification code for Resy auth
router.post('/resy/request-code', async (req, res) => {
  try {
    const { phoneNumber } = req.body;
    
    if (!phoneNumber) {
      res.status(400).json({ 
        success: false, 
        error: 'Phone number is required' 
      } as ApiResponse<never>);
      return;
    }
    
    await requestSmsCode(phoneNumber);
    
    res.json({ 
      success: true, 
      data: { message: 'SMS code sent successfully' }
    } as ApiResponse<{ message: string }>);
  } catch (error) {
    console.error('Error requesting SMS code:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to request SMS code' 
    } as ApiResponse<never>);
  }
});

// Verify SMS code and get auth token
router.post('/resy/verify-code', async (req, res) => {
  try {
    const { phoneNumber, code } = req.body;
    
    if (!phoneNumber || !code) {
      res.status(400).json({ 
        success: false, 
        error: 'Phone number and code are required' 
      } as ApiResponse<never>);
      return;
    }
    
    const authToken = await verifySmsCode(phoneNumber, code);
    
    res.json({ 
      success: true, 
      data: { authToken }
    } as ApiResponse<{ authToken: string }>);
  } catch (error) {
    console.error('Error verifying SMS code:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to verify SMS code' 
    } as ApiResponse<never>);
  }
});

export default router;
